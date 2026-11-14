import { z } from 'zod';
import { requireEnv } from '../config/load.js';
import { ConfigError } from '../errors.js';

export const llmProfileSchema = z
  .object({
    apiStyle: z.literal('openai-chat'),
    baseUrl: z.string().url(),
    apiKeyEnv: z.string().min(1),
    model: z.string().min(1),
    timeoutMs: z.number().int().positive(),
    maxRetries: z.number().int().min(0),
    retryBaseDelayMs: z.number().int().min(0),
  })
  .strict();

export const imageProfileSchema = z
  .object({
    apiStyle: z.literal('openai-images'),
    baseUrl: z.string().url(),
    apiKeyEnv: z.string().min(1),
    model: z.string().min(1),
    size: z.string().min(1),
    timeoutMs: z.number().int().positive(),
    maxRetries: z.number().int().min(0),
  })
  .strict();

export const llmConfigSchema = z
  .object({
    profiles: z.record(llmProfileSchema),
    image: imageProfileSchema,
  })
  .strict();

export type LlmConfig = z.infer<typeof llmConfigSchema>;
export type LlmProfile = z.infer<typeof llmProfileSchema>;
export type ImageProfile = z.infer<typeof imageProfileSchema>;

export interface ResolvedLlmProfile extends LlmProfile {
  name: string;
  apiKey: string;
}

export interface ResolvedImageProfile extends ImageProfile {
  apiKey: string;
}

const PLACEHOLDER_HOST = 'example-gateway';
const PLACEHOLDER_MODEL = 'your-model-id';
const PLACEHOLDER_IMAGE_MODEL = 'your-image-model-id';

function rejectPlaceholders(what: string, baseUrl: string, model: string): void {
  let host = '';
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    host = '';
  }
  if (host === PLACEHOLDER_HOST || model === PLACEHOLDER_MODEL || model === PLACEHOLDER_IMAGE_MODEL) {
    throw new ConfigError(
      'LLM_PLACEHOLDER_CONFIG',
      `${what} still points at the example gateway or model. Edit config/llm.json and set a real baseUrl and model.`,
      { what, baseUrl, model },
    );
  }
}

/** Resolves a named chat profile. Unknown names are an error, never a default. */
export function resolveProfile(config: LlmConfig, name: string): ResolvedLlmProfile {
  const profile = config.profiles[name];
  if (!profile) {
    throw new ConfigError(
      'LLM_PROFILE_UNKNOWN',
      `LLM profile "${name}" is not defined in config/llm.json. Known profiles: ${Object.keys(config.profiles).join(', ') || '<none>'}.`,
      { name, known: Object.keys(config.profiles) },
    );
  }
  rejectPlaceholders(`LLM profile "${name}"`, profile.baseUrl, profile.model);
  return { ...profile, name, apiKey: requireEnv(profile.apiKeyEnv) };
}

export function resolveImageProfile(config: LlmConfig): ResolvedImageProfile {
  rejectPlaceholders('Image profile', config.image.baseUrl, config.image.model);
  return { ...config.image, apiKey: requireEnv(config.image.apiKeyEnv) };
}
