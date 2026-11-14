import { mkdirSync, openSync, closeSync, writeSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { StorageError, toLogError, type LogError } from '../errors.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  seq: number;
  ts: string;
  runId: string;
  pipelineId: string;
  level: LogLevel;
  event: string;
  stage?: string;
  data?: Record<string, unknown>;
  error?: LogError;
}

export interface JsonlLoggerOptions {
  file: string;
  runId: string;
  pipelineId: string;
  /** Human readable console mirror. The CLI enables it, tests do not. */
  mirror?: boolean;
  /** Directory for optional LLM transcripts (usually the run's artifacts dir). */
  artifactsDir?: string;
  saveLlmTranscripts?: boolean;
}

const SECRET_KEY = /api[-_]?key|authorization|cookie|token|password/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? '[redacted]' : redact(entry);
    }
    return out;
  }
  return value;
}

/**
 * Append-only JSONL event log, one file per run. There is deliberately no API
 * to truncate or rewrite it, and a failed write is an error, never a warning.
 */
export class JsonlLogger {
  readonly file: string;
  readonly runId: string;
  readonly pipelineId: string;
  readonly #mirror: boolean;
  readonly #artifactsDir?: string;
  readonly #saveLlmTranscripts: boolean;
  #fd: number | null;
  #seq = 0;

  constructor(opts: JsonlLoggerOptions) {
    this.file = opts.file;
    this.runId = opts.runId;
    this.pipelineId = opts.pipelineId;
    this.#mirror = opts.mirror ?? false;
    this.#artifactsDir = opts.artifactsDir;
    this.#saveLlmTranscripts = opts.saveLlmTranscripts ?? false;
    try {
      mkdirSync(dirname(opts.file), { recursive: true });
      this.#fd = openSync(opts.file, 'a');
    } catch (err) {
      throw new StorageError(
        'LOG_WRITE_FAILED',
        `Cannot open run log ${opts.file} for appending.`,
        { path: opts.file },
        { cause: err },
      );
    }
  }

  get saveLlmTranscripts(): boolean {
    return this.#saveLlmTranscripts;
  }

  log(level: LogLevel, event: string, extra: { stage?: string; data?: Record<string, unknown>; error?: unknown } = {}): void {
    if (this.#fd === null) {
      throw new StorageError('LOG_WRITE_FAILED', `Run log ${this.file} is closed.`, { path: this.file, event });
    }
    const record: LogRecord = {
      seq: ++this.#seq,
      ts: new Date().toISOString(),
      runId: this.runId,
      pipelineId: this.pipelineId,
      level,
      event,
    };
    if (extra.stage !== undefined) record.stage = extra.stage;
    if (extra.data !== undefined) record.data = redact(extra.data) as Record<string, unknown>;
    if (extra.error !== undefined) record.error = toLogError(extra.error);

    const line = `${JSON.stringify(record)}\n`;
    try {
      writeSync(this.#fd, line);
    } catch (err) {
      throw new StorageError(
        'LOG_WRITE_FAILED',
        `Failed to append to run log ${this.file}.`,
        { path: this.file, event },
        { cause: err },
      );
    }
    if (this.#mirror) {
      const stage = record.stage ? ` [${record.stage}]` : '';
      const data = record.data ? ` ${JSON.stringify(record.data)}` : '';
      const error = record.error ? ` ${record.error.code ?? record.error.name}: ${record.error.message}` : '';
      process.stderr.write(`${record.ts} ${level.toUpperCase()} ${event}${stage}${data}${error}\n`);
    }
  }

  debug(event: string, extra?: { stage?: string; data?: Record<string, unknown> }): void {
    this.log('debug', event, extra);
  }

  info(event: string, extra?: { stage?: string; data?: Record<string, unknown> }): void {
    this.log('info', event, extra);
  }

  warn(event: string, extra?: { stage?: string; data?: Record<string, unknown>; error?: unknown }): void {
    this.log('warn', event, extra);
  }

  error(event: string, extra?: { stage?: string; data?: Record<string, unknown>; error?: unknown }): void {
    this.log('error', event, extra);
  }

  /**
   * Persists a full LLM request/response. Only called when
   * logging.saveLlmTranscripts is true; returns the absolute path written.
   */
  async saveLlmTranscript(relativePath: string, payload: unknown): Promise<string> {
    if (!this.#saveLlmTranscripts) {
      throw new StorageError(
        'LOG_TRANSCRIPT_DISABLED',
        'LLM transcripts are disabled (logging.saveLlmTranscripts is false).',
        { path: relativePath },
      );
    }
    if (!this.#artifactsDir) {
      throw new StorageError('LOG_TRANSCRIPT_DISABLED', 'No artifacts directory configured for transcripts.', {
        path: relativePath,
      });
    }
    const target = join(this.#artifactsDir, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(redact(payload), null, 2)}\n`, 'utf8');
    return target;
  }

  close(): void {
    if (this.#fd === null) return;
    try {
      closeSync(this.#fd);
    } finally {
      this.#fd = null;
    }
  }
}
