import type { ZodType } from 'zod';
import { LlmError } from '../errors.js';
import type { ChatRequest, LlmClient } from './types.js';

type JsonChatRequest = Omit<ChatRequest, 'responseFormat'>;

/**
 * Accepts either the whole content as JSON, or exactly one ```json fenced
 * block surrounded only by whitespace. It never scans prose for an object.
 */
export function extractJsonText(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed;

  const fenced = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/.exec(trimmed);
  if (fenced) {
    const inner = (fenced[1] ?? '').trim();
    if (inner.startsWith('{') || inner.startsWith('[')) return inner;
  }
  throw new LlmError(
    'LLM_INVALID_JSON',
    'LLM reply was not JSON and was not a single ```json fenced block.',
    { preview: content.slice(0, 500) },
  );
}

/**
 * Calls the model with response_format=json_object, parses the reply and
 * validates it. On either failure the raw reply is saved through `sink` and
 * its path is included in the error context.
 */
export async function chatJson<T>(
  llm: LlmClient,
  req: JsonChatRequest,
  schema: ZodType<T>,
  sink?: (raw: string) => Promise<string>,
): Promise<T> {
  const response = await llm.chat({ ...req, responseFormat: 'json_object' });

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(response.content));
  } catch (err) {
    const path = await persistRaw(sink, response.content);
    throw new LlmError(
      'LLM_INVALID_JSON',
      `LLM reply for ${req.context.stage}/${req.context.task} was not valid JSON.`,
      { ...req.context, ...(path ? { rawReplyPath: path } : {}), preview: response.content.slice(0, 500) },
      false,
      undefined,
      { cause: err },
    );
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const path = await persistRaw(sink, response.content);
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
      code: issue.code,
    }));
    throw new LlmError(
      'LLM_SCHEMA_MISMATCH',
      `LLM reply for ${req.context.stage}/${req.context.task} did not match the expected schema: ${issues
        .map((issue) => `${issue.path || '<root>'}: ${issue.message}`)
        .join('; ')}`,
      { ...req.context, issues, ...(path ? { rawReplyPath: path } : {}) },
    );
  }
  return result.data;
}

async function persistRaw(
  sink: ((raw: string) => Promise<string>) | undefined,
  raw: string,
): Promise<string | undefined> {
  if (!sink) return undefined;
  try {
    return await sink(raw);
  } catch (err) {
    // The original LLM failure is what the caller needs; note the sink failure
    // in the error context instead of replacing it.
    return `unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }
}
