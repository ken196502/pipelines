import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { StorageError } from '../errors.js';
import { ensureDirExclusive, writeFileAtomic, writeJsonAtomic } from '../fs/atomic.js';
import { assertSafeKey, assertSafeRunId, newRunId } from '../ids.js';
import { assertStorageRoot } from './root.js';

const logErrorSchema = z
  .object({
    name: z.string(),
    code: z.string().optional(),
    message: z.string(),
    context: z.record(z.unknown()).optional(),
    stack: z.string().optional(),
    cause: z
      .object({ name: z.string(), code: z.string().optional(), message: z.string() })
      .strict()
      .optional(),
  })
  .strict();

const stageManifestSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(['pending', 'running', 'succeeded', 'failed', 'not-run']),
    startedAt: z.string().optional(),
    finishedAt: z.string().optional(),
    durationMs: z.number().nonnegative().optional(),
    outputs: z.array(z.string()).optional(),
    error: logErrorSchema.optional(),
  })
  .strict();

export const runManifestSchema = z
  .object({
    runId: z.string().min(1),
    pipelineId: z.string().min(1),
    status: z.enum(['running', 'succeeded', 'failed']),
    startedAt: z.string(),
    finishedAt: z.string().optional(),
    configPath: z.string(),
    configSha256: z.string().regex(/^[0-9a-f]{64}$/),
    configSnapshot: z.unknown(),
    overrides: z.record(z.unknown()),
    stages: z.array(stageManifestSchema),
    result: z.record(z.unknown()).optional(),
    error: logErrorSchema.optional(),
  })
  .strict();

export type RunManifest = z.infer<typeof runManifestSchema>;
export type StageManifest = z.infer<typeof stageManifestSchema>;

/**
 * One run directory:
 *   run.json, events.jsonl, artifacts/, evidence/, webdriver/
 */
export class RunStore {
  readonly root: string;
  readonly pipelineId: string;
  readonly runId: string;
  readonly dir: string;
  readonly artifactsDir: string;
  readonly evidenceDir: string;
  readonly webdriverDir: string;
  readonly manifestPath: string;
  #tail: Promise<void> = Promise.resolve();

  private constructor(root: string, pipelineId: string, runId: string) {
    this.root = root;
    this.pipelineId = pipelineId;
    this.runId = runId;
    this.dir = join(root, 'pipelines', pipelineId, 'runs', runId);
    this.artifactsDir = join(this.dir, 'artifacts');
    this.evidenceDir = join(this.dir, 'evidence');
    this.webdriverDir = join(this.dir, 'webdriver');
    this.manifestPath = join(this.dir, 'run.json');
  }

  static async create(root: string, pipelineId: string, runId: string = newRunId()): Promise<RunStore> {
    const resolvedRoot = assertStorageRoot(root);
    assertSafeKey(pipelineId);
    assertSafeRunId(runId);
    const store = new RunStore(resolvedRoot, pipelineId, runId);
    await ensureDirExclusive(store.dir);
    await writeJsonAtomic(store.manifestPath, {
      runId,
      pipelineId,
      status: 'running',
      startedAt: new Date().toISOString(),
      configPath: '',
      configSha256: '0'.repeat(64),
      configSnapshot: {},
      overrides: {},
      stages: [],
    } satisfies RunManifest);
    return store;
  }

  /** Resolves an artifact path, rejecting traversal in every segment. */
  artifactPath(name: string): string {
    const segments = name.split('/');
    if (segments.length === 0 || segments.some((segment) => segment === '')) {
      throw new StorageError('STORAGE_UNSAFE_KEY', `Invalid artifact name ${JSON.stringify(name)}.`, { name });
    }
    for (const segment of segments) assertSafeKey(segment);
    return join(this.artifactsDir, ...segments);
  }

  async writeArtifact(name: string, data: string | Buffer | object): Promise<string> {
    const path = this.artifactPath(name);
    if (typeof data === 'string' || Buffer.isBuffer(data)) {
      await writeFileAtomic(path, data);
    } else {
      await writeJsonAtomic(path, data);
    }
    return path;
  }

  async readManifest(): Promise<RunManifest> {
    let raw: string;
    try {
      raw = await readFile(this.manifestPath, 'utf8');
    } catch (err) {
      throw new StorageError('MANIFEST_READ_FAILED', `Cannot read ${this.manifestPath}.`, { path: this.manifestPath }, {
        cause: err,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new StorageError('MANIFEST_CORRUPT', `Run manifest ${this.manifestPath} is not valid JSON.`, {
        path: this.manifestPath,
      }, { cause: err });
    }
    const result = runManifestSchema.safeParse(parsed);
    if (!result.success) {
      throw new StorageError('MANIFEST_CORRUPT', `Run manifest ${this.manifestPath} does not match its schema.`, {
        path: this.manifestPath,
        issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return result.data;
  }

  /** Read-modify-write, serialized so concurrent stage updates cannot be lost. */
  updateManifest(patch: Partial<RunManifest>): Promise<void> {
    return this.#withLock(async () => {
      const current = await this.readManifest();
      const next: RunManifest = { ...current, ...patch };
      await writeJsonAtomic(this.manifestPath, next);
    });
  }

  async #withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
