import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ZodType } from 'zod';
import { StorageError } from '../errors.js';
import { writeJsonAtomic } from '../fs/atomic.js';
import { assertSafeKey } from '../ids.js';
import { assertStorageRoot } from './root.js';

/**
 * Pipeline-level key/value store, persisted under
 * <root>/pipelines/<pipelineId>/store/<namespace>/<key>.json.
 */
export class PipelineStore {
  readonly root: string;
  readonly pipelineId: string;
  readonly dir: string;

  constructor(root: string, pipelineId: string) {
    this.root = assertStorageRoot(root);
    this.pipelineId = assertSafeKey(pipelineId);
    this.dir = join(this.root, 'pipelines', this.pipelineId, 'store');
  }

  pathFor(namespace: string, key: string): string {
    assertSafeKey(namespace);
    assertSafeKey(key);
    return join(this.dir, namespace, `${key}.json`);
  }

  /** Returns undefined only when the file does not exist. */
  async readJson<T>(namespace: string, key: string, schema: ZodType<T>): Promise<T | undefined> {
    const path = this.pathFor(namespace, key);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new StorageError('STORE_READ_FAILED', `Cannot read store file ${path}.`, { path }, { cause: err });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new StorageError(
        'STORE_CORRUPT',
        `Store file ${path} is not valid JSON. Fix or remove it deliberately; it is not treated as empty.`,
        { path },
        { cause: err },
      );
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new StorageError(
        'STORE_CORRUPT',
        `Store file ${path} does not match its schema.`,
        { path, issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
      );
    }
    return result.data;
  }

  async writeJson(namespace: string, key: string, value: unknown): Promise<void> {
    await writeJsonAtomic(this.pathFor(namespace, key), value);
  }

  async listKeys(namespace: string): Promise<string[]> {
    assertSafeKey(namespace);
    try {
      const entries = await readdir(join(this.dir, namespace), { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => entry.name.slice(0, -'.json'.length))
        .sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new StorageError('STORE_READ_FAILED', `Cannot list namespace ${namespace}.`, { namespace }, { cause: err });
    }
  }
}
