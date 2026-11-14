import { ImageError, LlmError, PipelineTemplateError } from '../errors.js';
import type { JsonlLogger } from '../log/jsonl-logger.js';

export interface HttpRetryOptions {
  url: string;
  body: unknown;
  headers: Record<string, string>;
  timeoutMs: number;
  maxRetries: number;
  baseDelayMs: number;
  kind: 'llm' | 'image';
  context: { stage: string; task: string };
  logger: JsonlLogger;
  retryEvent: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface HttpJsonResult {
  status: number;
  json: unknown;
  text: string;
}

const RETRY_AFTER_CAP_MS = 30_000;
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED']);

function codeOf(err: unknown): string | undefined {
  const direct = (err as { code?: unknown }).code;
  if (typeof direct === 'string') return direct;
  const cause = (err as { cause?: { code?: unknown } }).cause;
  if (cause && typeof cause.code === 'string') return cause.code;
  return undefined;
}

function isTransientTransportError(err: unknown): boolean {
  const code = codeOf(err);
  if (code && (TRANSIENT_CODES.has(code) || code.startsWith('UND_ERR_'))) return true;
  const message = err instanceof Error ? err.message : '';
  return message.includes('UND_ERR_');
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(seconds * 1000, RETRY_AFTER_CAP_MS));
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.min(date - Date.now(), RETRY_AFTER_CAP_MS));
}

function makeError(
  opts: HttpRetryOptions,
  code: string,
  message: string,
  context: Record<string, unknown>,
  retryable: boolean,
  status?: number,
  cause?: unknown,
): PipelineTemplateError {
  if (opts.kind === 'llm') {
    return new LlmError(code, message, { ...opts.context, ...context }, retryable, status, { cause });
  }
  return new ImageError(code, message, { ...opts.context, ...context }, { cause });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new PipelineTemplateError('REQUEST_ABORTED', 'Request aborted while waiting to retry.', {}));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * POSTs JSON and retries only transport errors, timeouts, HTTP 429 and 5xx.
 * Every retry sends the same request; nothing is changed between attempts.
 */
export async function postJsonWithRetry(opts: HttpRetryOptions): Promise<HttpJsonResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const prefix = opts.kind === 'llm' ? 'LLM' : 'IMAGE';
  const attempts = opts.maxRetries + 1;
  let lastStatus: number | undefined;
  let lastCause: string | undefined;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (opts.signal?.aborted) {
      throw makeError(opts, `${prefix}_ABORTED`, 'Request aborted before it was sent.', { attempts: attempt - 1 }, false);
    }
    const timeoutController = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, opts.timeoutMs);
    const signal = opts.signal
      ? AbortSignal.any([timeoutController.signal, opts.signal])
      : timeoutController.signal;

    let status: number;
    let text: string;
    let retryAfter: string | null = null;
    try {
      const response = await fetchImpl(opts.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...opts.headers },
        body: JSON.stringify(opts.body),
        signal,
      });
      status = response.status;
      retryAfter = response.headers.get('retry-after');
      text = await response.text();
    } catch (err) {
      if (opts.signal?.aborted) {
        throw makeError(opts, `${prefix}_ABORTED`, 'Request aborted by the caller.', { attempts: attempt }, false, undefined, err);
      }
      if (timedOut) {
        lastCause = 'timeout';
        lastStatus = undefined;
      } else if (isTransientTransportError(err)) {
        lastCause = codeOf(err) ?? 'transport';
      } else {
        throw makeError(
          opts,
          `${prefix}_REQUEST_FAILED`,
          `Request to ${opts.url} failed with a non-retryable transport error.`,
          { attempts: attempt, url: opts.url },
          false,
          undefined,
          err,
        );
      }
      if (attempt === attempts) break;
      const delay = Math.min(opts.baseDelayMs * 2 ** (attempt - 1), RETRY_AFTER_CAP_MS);
      opts.logger.log('warn', opts.retryEvent, {
        stage: opts.context.stage,
        data: { attempt, delayMs: delay, cause: lastCause, task: opts.context.task },
      });
      await sleep(delay, opts.signal);
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (status >= 200 && status < 300) {
      try {
        return { status, json: JSON.parse(text) as unknown, text };
      } catch (err) {
        throw makeError(
          opts,
          `${prefix}_MALFORMED_RESPONSE`,
          `Response from ${opts.url} was not valid JSON (HTTP ${status}).`,
          { status, url: opts.url, bodyPreview: text.slice(0, 2048) },
          false,
          status,
          err,
        );
      }
    }

    if (status === 429 || status >= 500) {
      lastStatus = status;
      lastCause = `http_${status}`;
      if (attempt === attempts) break;
      const delay =
        retryAfterMs(retryAfter) ?? Math.min(opts.baseDelayMs * 2 ** (attempt - 1), RETRY_AFTER_CAP_MS);
      opts.logger.log('warn', opts.retryEvent, {
        stage: opts.context.stage,
        data: { attempt, delayMs: delay, cause: lastCause, status, task: opts.context.task },
      });
      await sleep(delay, opts.signal);
      continue;
    }

    throw makeError(
      opts,
      `${prefix}_HTTP_ERROR`,
      `Request to ${opts.url} failed with HTTP ${status}: ${text.slice(0, 2048)}`,
      { status, url: opts.url, bodyPreview: text.slice(0, 2048) },
      false,
      status,
    );
  }

  throw makeError(
    opts,
    `${prefix}_REQUEST_FAILED`,
    `Request to ${opts.url} failed after ${attempts} attempt(s) (last status ${lastStatus ?? 'none'}, last cause ${lastCause ?? 'unknown'}).`,
    { attempts, lastStatus, lastCause, url: opts.url },
    true,
    lastStatus,
  );
}
