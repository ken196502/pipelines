/**
 * Typed error taxonomy for the template.
 *
 * Every failure that the pipeline can explain carries a stable `code`, a human
 * readable message that names what failed and what to do about it, and a
 * context object with machine readable details (stage, url, selector, path...).
 */

export interface SerializedCause {
  name: string;
  code?: string;
  message: string;
}

export interface LogError {
  name: string;
  code?: string;
  message: string;
  context?: Record<string, unknown>;
  stack?: string;
  cause?: SerializedCause;
}

export class PipelineTemplateError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly context: Record<string, unknown> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ConfigError extends PipelineTemplateError {}

export class StorageError extends PipelineTemplateError {}

export class LlmError extends PipelineTemplateError {
  constructor(
    code: string,
    message: string,
    context: Record<string, unknown> = {},
    readonly retryable = false,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(code, message, context, options);
  }
}

export class ImageError extends PipelineTemplateError {}

export class BrowserError extends PipelineTemplateError {}

export class XError extends PipelineTemplateError {}

function serializeCause(cause: unknown): SerializedCause | undefined {
  if (cause === undefined || cause === null) return undefined;
  if (cause instanceof PipelineTemplateError) {
    return { name: cause.name, code: cause.code, message: cause.message };
  }
  if (cause instanceof Error) {
    return { name: cause.name, message: cause.message };
  }
  if (typeof cause === 'object' && 'message' in cause) {
    const value = cause as { name?: unknown; message?: unknown };
    return {
      name: typeof value.name === 'string' ? value.name : 'Error',
      message: String(value.message),
    };
  }
  return { name: 'NonError', message: String(cause) };
}

export function toLogError(err: unknown): LogError {
  if (err instanceof PipelineTemplateError) {
    const cause = serializeCause(err.cause);
    return {
      name: err.name,
      code: err.code,
      message: err.message,
      context: err.context,
      stack: err.stack,
      ...(cause ? { cause } : {}),
    };
  }
  if (err instanceof Error) {
    const cause = serializeCause(err.cause);
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      ...(cause ? { cause } : {}),
    };
  }
  return { name: 'NonError', message: String(err) };
}
