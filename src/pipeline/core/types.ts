import type { ZodType } from 'zod';
import type { PipelineTemplateError } from '../../lib/errors.js';
import type { JsonlLogger } from '../../lib/log/jsonl-logger.js';
import type { PipelineStore } from '../../lib/storage/pipeline-store.js';
import type { RunStore } from '../../lib/storage/run-store.js';

export interface StageContext<C, D> {
  config: C;
  deps: D;
  run: RunStore;
  store: PipelineStore;
  log: JsonlLogger;
  stageId: string;
  signal: AbortSignal;
  /** Records an artifact path produced by this stage for run.json and the log. */
  recordOutput(path: string): void;
}

export interface StageDefinition<C, D, S> {
  id: string;
  description: string;
  /** Returns the state additions for this stage. */
  run(ctx: StageContext<C, D>, state: S): Promise<Partial<S>>;
}

export interface FinalizeOutcome {
  status: 'succeeded' | 'failed';
  error?: PipelineTemplateError;
}

export interface PipelineDefinition<C, D, S> {
  id: string;
  configSchema: ZodType<C>;
  stages: readonly StageDefinition<C, D, S>[];
  /** Always runs, on success and failure. It must not mask a stage error. */
  finalize?(ctx: StageContext<C, D>, state: S, outcome: FinalizeOutcome): Promise<void>;
}

export interface RunOutcome<S> {
  runId: string;
  runDir: string;
  status: 'succeeded';
  state: S;
}
