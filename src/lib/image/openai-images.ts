import { ImageError } from '../errors.js';
import { postJsonWithRetry } from '../http/retry.js';
import type { JsonlLogger } from '../log/jsonl-logger.js';
import type { ResolvedImageProfile } from '../llm/config.js';

export interface ImageRequest {
  prompt: string;
  context: { stage: string; task: string };
  signal?: AbortSignal;
}

export interface ImageResponse {
  bytes: Buffer;
}

export interface ImageClient {
  generate(req: ImageRequest): Promise<ImageResponse>;
}

interface OpenAiImagePayload {
  data?: unknown;
}

function readFirstItem(payload: unknown): Record<string, unknown> | undefined {
  const data = (payload as OpenAiImagePayload)?.data;
  if (!Array.isArray(data) || data.length === 0) return undefined;
  const item = data[0];
  return item !== null && typeof item === 'object' ? (item as Record<string, unknown>) : undefined;
}

/**
 * OpenAI-compatible images/generations client. Accepts b64_json or url in the
 * response and retries only transport errors, timeouts, 429 and 5xx.
 */
export function createOpenAiImageClient(
  profile: ResolvedImageProfile,
  logger: JsonlLogger,
  fetchImpl: typeof fetch = fetch,
): ImageClient {
  const url = `${profile.baseUrl.replace(/\/+$/, '')}/images/generations`;

  return {
    async generate(req: ImageRequest): Promise<ImageResponse> {
      logger.info('image:request', {
        stage: req.context.stage,
        data: { task: req.context.task, model: profile.model, size: profile.size, promptChars: req.prompt.length },
      });

      const result = await postJsonWithRetry({
        url,
        body: {
          model: profile.model,
          prompt: req.prompt,
          size: profile.size,
          n: 1,
          response_format: 'b64_json',
        },
        headers: { authorization: `Bearer ${profile.apiKey}` },
        timeoutMs: profile.timeoutMs,
        maxRetries: profile.maxRetries,
        baseDelayMs: 1000,
        kind: 'image',
        context: req.context,
        logger,
        retryEvent: 'image:retry',
        ...(req.signal ? { signal: req.signal } : {}),
        fetchImpl,
      });

      const item = readFirstItem(result.json);
      if (!item) {
        throw new ImageError(
          'IMAGE_EMPTY_RESPONSE',
          `Image response from ${url} contained no data[0].`,
          { ...req.context, bodyPreview: result.text.slice(0, 2048) },
        );
      }

      if (typeof item.b64_json === 'string' && item.b64_json.length > 0) {
        const bytes = Buffer.from(item.b64_json, 'base64');
        logger.info('image:response', {
          stage: req.context.stage,
          data: { task: req.context.task, source: 'b64_json', bytes: bytes.length },
        });
        return { bytes };
      }

      if (typeof item.url === 'string' && item.url.length > 0) {
        let response: Response;
        try {
          response = await fetchImpl(item.url, {
            signal: req.signal ?? AbortSignal.timeout(profile.timeoutMs),
          });
        } catch (err) {
          throw new ImageError(
            'IMAGE_DOWNLOAD_FAILED',
            `Failed to download generated image from ${item.url}.`,
            { ...req.context, url: item.url },
            { cause: err },
          );
        }
        if (!response.ok) {
          throw new ImageError(
            'IMAGE_DOWNLOAD_FAILED',
            `Failed to download generated image from ${item.url}: HTTP ${response.status}.`,
            { ...req.context, url: item.url, status: response.status },
          );
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        logger.info('image:response', {
          stage: req.context.stage,
          data: { task: req.context.task, source: 'url', bytes: bytes.length },
        });
        return { bytes };
      }

      throw new ImageError(
        'IMAGE_EMPTY_RESPONSE',
        `Image response from ${url} had neither b64_json nor url.`,
        { ...req.context, keys: Object.keys(item) },
      );
    },
  };
}
