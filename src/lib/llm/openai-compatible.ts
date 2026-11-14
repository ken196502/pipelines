import { LlmError } from '../errors.js';
import { postJsonWithRetry } from '../http/retry.js';
import type { JsonlLogger } from '../log/jsonl-logger.js';
import type { ResolvedLlmProfile } from './config.js';
import type { ChatRequest, ChatResponse, LlmClient } from './types.js';

interface OpenAiChatResponse {
  model?: unknown;
  choices?: unknown;
  usage?: unknown;
}

function readUsage(value: unknown): ChatResponse['usage'] {
  if (value === null || typeof value !== 'object') return undefined;
  const usage = value as Record<string, unknown>;
  const result: NonNullable<ChatResponse['usage']> = {};
  if (typeof usage.prompt_tokens === 'number') result.promptTokens = usage.prompt_tokens;
  if (typeof usage.completion_tokens === 'number') result.completionTokens = usage.completion_tokens;
  if (typeof usage.total_tokens === 'number') result.totalTokens = usage.total_tokens;
  return result;
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'call';
}

/**
 * OpenAI-compatible chat completions client (non-streaming).
 * Streaming and the Responses API are out of scope for v1.
 */
export function createOpenAiCompatibleClient(
  profile: ResolvedLlmProfile,
  logger: JsonlLogger,
  fetchImpl: typeof fetch = fetch,
): LlmClient {
  const url = `${profile.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  let transcriptCount = 0;

  return {
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const characters = req.messages.reduce((sum, message) => sum + message.content.length, 0);
      logger.info('llm:request', {
        stage: req.context.stage,
        data: {
          task: req.context.task,
          profile: profile.name,
          model: profile.model,
          messages: req.messages.length,
          characters,
          maxTokens: req.maxTokens,
          responseFormat: req.responseFormat ?? 'text',
        },
      });

      const body: Record<string, unknown> = {
        model: profile.model,
        messages: req.messages,
        max_tokens: req.maxTokens,
      };
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (req.responseFormat === 'json_object') body.response_format = { type: 'json_object' };

      const result = await postJsonWithRetry({
        url,
        body,
        headers: { authorization: `Bearer ${profile.apiKey}` },
        timeoutMs: profile.timeoutMs,
        maxRetries: profile.maxRetries,
        baseDelayMs: profile.retryBaseDelayMs,
        kind: 'llm',
        context: req.context,
        logger,
        retryEvent: 'llm:retry',
        ...(req.signal ? { signal: req.signal } : {}),
        fetchImpl,
      });

      const payload = result.json as OpenAiChatResponse;
      const choices = payload?.choices;
      if (!Array.isArray(choices) || choices.length === 0) {
        throw new LlmError(
          'LLM_MALFORMED_RESPONSE',
          `Chat response from ${url} has no choices[0].`,
          { ...req.context, bodyPreview: result.text.slice(0, 2048) },
        );
      }
      const choice = choices[0] as Record<string, unknown>;
      const message = choice.message as Record<string, unknown> | undefined;
      const content = typeof message?.content === 'string' ? message.content : '';
      const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : 'unknown';

      if (finishReason === 'length') {
        throw new LlmError(
          'LLM_TRUNCATED',
          `Chat response from ${url} was truncated (finish_reason=length). Raise maxTokens for this stage.`,
          { ...req.context, maxTokens: req.maxTokens },
        );
      }
      if (content.trim() === '') {
        throw new LlmError('LLM_EMPTY', `Chat response from ${url} had empty content.`, { ...req.context });
      }

      logger.info('llm:response', {
        stage: req.context.stage,
        data: {
          task: req.context.task,
          model: typeof payload.model === 'string' ? payload.model : profile.model,
          finishReason,
          characters: content.length,
          usage: readUsage(payload.usage),
        },
      });

      if (logger.saveLlmTranscripts) {
        transcriptCount += 1;
        const name = `${safeName(req.context.stage)}-${transcriptCount}.json`;
        await logger.saveLlmTranscript(`llm/${name}`, {
          context: req.context,
          model: profile.model,
          request: { messages: req.messages, maxTokens: req.maxTokens, temperature: req.temperature },
          response: { content, finishReason, usage: readUsage(payload.usage) },
        });
      }

      const response: ChatResponse = {
        content,
        model: typeof payload.model === 'string' ? payload.model : profile.model,
        finishReason,
      };
      const usage = readUsage(payload.usage);
      if (usage) response.usage = usage;
      return response;
    },
  };
}
