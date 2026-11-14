import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ConfigError, PipelineTemplateError, toLogError } from '../../lib/errors.js';
import { JsonlLogger } from '../../lib/log/jsonl-logger.js';
import { PipelineStore } from '../../lib/storage/pipeline-store.js';
import { RunStore, type StageManifest } from '../../lib/storage/run-store.js';
import type { FinalizeOutcome, PipelineDefinition, RunOutcome, StageContext } from './types.js';

export interface RunPipelineOptions<C, D, S> {
  definition: PipelineDefinition<C, D, S>;
  configPath: string;
  config: C;
  overrides: Record<string, unknown>;
  deps: D;
  storageRoot: string;
  runId?: string;
  signal?: AbortSignal;
  mirror?: boolean;
  saveLlmTranscripts?: boolean;
  /** Called once the run directory and logger exist, for signal handling. */
  onRunCreated?: (run: RunStore, log: JsonlLogger) => void;
}

function toPipelineError(err: unknown, runDir: string): PipelineTemplateError {
  if (err instanceof PipelineTemplateError) {
    return err;
  }
  return new PipelineTemplateError(
    'UNEXPECTED_ERROR',
    `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    { runDir },
    { cause: err },
  );
}

async function configHash(path: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    throw new ConfigError('CONFIG_READ_FAILED', `Cannot read config file ${path} to hash it.`, { path }, { cause: err });
  }
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Runs stages sequentially. Every stage updates run.json and the JSONL log.
 * A failure marks the remaining stages `not-run`, always runs finalize, and
 * rethrows the original error with the run directory attached.
 */
export async function runPipeline<C, D, S>(opts: RunPipelineOptions<C, D, S>): Promise<RunOutcome<S>> {
  const { definition } = opts;
  const sha256 = await configHash(opts.configPath);
  const run = await RunStore.create(opts.storageRoot, definition.id, opts.runId);
  const store = new PipelineStore(opts.storageRoot, definition.id);
  const log = new JsonlLogger({
    file: `${run.dir}/events.jsonl`,
    runId: run.runId,
    pipelineId: definition.id,
    mirror: opts.mirror ?? false,
    artifactsDir: run.artifactsDir,
    saveLlmTranscripts: opts.saveLlmTranscripts ?? false,
  });

  const stageManifests: StageManifest[] = definition.stages.map((stage) => ({ id: stage.id, status: 'pending' }));
  const signal = opts.signal ?? new AbortController().signal;

  opts.onRunCreated?.(run, log);

  await run.updateManifest({
    status: 'running',
    configPath: opts.configPath,
    configSha256: sha256,
    configSnapshot: opts.config,
    overrides: opts.overrides,
    stages: stageManifests,
  });

  log.info('run:start', {
    data: {
      runId: run.runId,
      runDir: run.dir,
      configPath: opts.configPath,
      configSha256: sha256,
      overrides: opts.overrides,
      stages: definition.stages.map((stage) => stage.id),
    },
  });

  let state = {} as S;
  let failure: PipelineTemplateError | undefined;

  try {
    for (const [index, stage] of definition.stages.entries()) {
      if (signal.aborted) {
        throw new PipelineTemplateError('RUN_INTERRUPTED', 'Run was interrupted before the stage started.', {
          runDir: run.dir,
          stage: stage.id,
        });
      }

      const startedAt = new Date().toISOString();
      const startedMs = Date.now();
      stageManifests[index] = { id: stage.id, status: 'running', startedAt };
      await run.updateManifest({ stages: stageManifests });
      log.info('stage:start', { stage: stage.id, data: { description: stage.description } });

      const outputs: string[] = [];
      const ctx: StageContext<C, D> = {
        config: opts.config,
        deps: opts.deps,
        run,
        store,
        log,
        stageId: stage.id,
        signal,
        recordOutput: (path: string) => outputs.push(path),
      };

      let additions: Partial<S>;
      try {
        additions = await stage.run(ctx, state);
      } catch (err) {
        const error = toPipelineError(err, run.dir);
        const finishedAt = new Date().toISOString();
        stageManifests[index] = {
          id: stage.id,
          status: 'failed',
          startedAt,
          finishedAt,
          durationMs: Date.now() - startedMs,
          error: toLogError(error),
        };
        for (let rest = index + 1; rest < stageManifests.length; rest += 1) {
          stageManifests[rest] = { id: definition.stages[rest]?.id ?? `stage-${rest}`, status: 'not-run' };
        }
        await run.updateManifest({
          status: 'failed',
          finishedAt,
          stages: stageManifests,
          error: toLogError(error),
        });
        log.error('stage:error', { stage: stage.id, error });
        throw error;
      }

      state = { ...state, ...additions };
      const durationMs = Date.now() - startedMs;
      const finishedAt = new Date().toISOString();
      const statePath = await run.writeArtifact(`state-${stage.id}.json`, state as object);
      outputs.push(statePath);
      stageManifests[index] = {
        id: stage.id,
        status: 'succeeded',
        startedAt,
        finishedAt,
        durationMs,
        outputs,
      };
      await run.updateManifest({ stages: stageManifests });
      log.info('stage:end', { stage: stage.id, data: { durationMs, outputs } });
    }
  } catch (err) {
    failure = toPipelineError(err, run.dir);
  }

  const outcome: FinalizeOutcome = failure ? { status: 'failed', error: failure } : { status: 'succeeded' };
  const finalizeOutputs: string[] = [];
  const finalizeCtx: StageContext<C, D> = {
    config: opts.config,
    deps: opts.deps,
    run,
    store,
    log,
    stageId: 'finalize',
    signal,
    recordOutput: (path: string) => finalizeOutputs.push(path),
  };

  try {
    if (definition.finalize) {
      await definition.finalize(finalizeCtx, state, outcome);
    }
  } catch (err) {
    const finalizeError = toPipelineError(err, run.dir);
    if (failure) {
      log.warn('run:finalize-error', {
        stage: 'finalize',
        data: { message: 'Finalize failed while handling a stage error; the stage error is preserved.' },
        error: finalizeError,
      });
    } else {
      failure = finalizeError;
    }
  }

  if (failure) {
    const finishedAt = new Date().toISOString();
    await run.updateManifest({ status: 'failed', finishedAt, error: toLogError(failure) });
    log.error('run:end', { data: { status: 'failed', runDir: run.dir }, error: failure });
    log.close();
    if (failure.context.runDir === undefined) {
      (failure.context as Record<string, unknown>).runDir = run.dir;
    }
    throw failure;
  }

  const finishedAt = new Date().toISOString();
  await run.updateManifest({ status: 'succeeded', finishedAt });
  log.info('run:end', { data: { status: 'succeeded', runDir: run.dir } });
  log.close();
  return { runId: run.runId, runDir: run.dir, status: 'succeeded', state };
}
