import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { ConfigError } from '../../lib/errors.js';

const positiveInt = z.number().int().positive();

export const xblogConfigSchema = z
  .object({
    language: z.enum(['en', 'zh']),
    keywords: z.array(z.string().min(1)).min(1),
    storage: z.object({ root: z.string().min(1) }).strict(),
    llm: z
      .object({
        profilesFile: z.string().min(1),
        relevance: z.string().min(1),
        article: z.string().min(1),
      })
      .strict(),
    browser: z
      .object({
        firefoxBinary: z.string().min(1),
        geckodriverBinary: z.string().min(1),
        headless: z.boolean(),
        windowSize: z.object({ width: positiveInt, height: positiveInt }).strict(),
        pageLoadTimeoutMs: positiveInt,
        proxy: z.object({ http: z.string().url(), https: z.string().url() }).strict().nullable(),
      })
      .strict(),
    auth: z
      .object({
        mode: z.enum(['profile', 'cookies']),
        profileDir: z.string().min(1).nullable(),
        cookiesFile: z.string().min(1).nullable(),
        expectedHandle: z.string().min(1).nullable(),
      })
      .strict(),
    search: z
      .object({
        feed: z.enum(['top', 'live']),
        tweetsPerKeyword: positiveInt,
        maxScrolls: z.number().int().min(0),
        useLangOperator: z.boolean(),
      })
      .strict(),
    relevance: z
      .object({
        minScore: z.number().int().min(0).max(10),
        maxSources: positiveInt,
        batchSize: positiveInt,
        maxTokens: positiveInt,
        excludeUsedSources: z.boolean(),
      })
      .strict(),
    article: z
      .object({
        minChars: positiveInt,
        maxChars: positiveInt,
        maxTokens: positiveInt,
      })
      .strict(),
    premium: z.object({ markers: z.array(z.string().min(1)).min(1) }).strict(),
    draft: z.object({ saveTimeoutMs: positiveInt }).strict(),
    logging: z.object({ saveLlmTranscripts: z.boolean() }).strict(),
  })
  .strict()
  .superRefine((config, ctx) => {
    const trimmed = config.keywords.map((keyword) => keyword.trim());
    trimmed.forEach((keyword, index) => {
      if (keyword === '') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['keywords', index], message: 'keyword must not be empty' });
      }
    });
    const seen = new Set<string>();
    trimmed.forEach((keyword, index) => {
      const key = keyword.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['keywords', index], message: `duplicate keyword "${keyword}"` });
      }
      seen.add(key);
    });
    if (config.article.minChars >= config.article.maxChars) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['article', 'minChars'],
        message: 'minChars must be smaller than maxChars',
      });
    }
    if (config.auth.mode === 'cookies' && config.auth.cookiesFile === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['auth', 'cookiesFile'],
        message: 'auth.mode is "cookies" but cookiesFile is null',
      });
    }
    if (config.auth.mode === 'profile' && config.auth.profileDir === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['auth', 'profileDir'],
        message: 'auth.mode is "profile" but profileDir is null',
      });
    }
  });

export type XblogConfig = z.infer<typeof xblogConfigSchema>;

export interface CliOverrides {
  language?: string;
  keywords?: string;
  headed?: boolean;
}

export interface AppliedOverrides {
  config: XblogConfig;
  recorded: Record<string, unknown>;
}

/**
 * Applies CLI overrides to the parsed config, then validates the result with
 * the same schema. Overrides are recorded verbatim in run.json.
 */
export function applyOverrides(config: XblogConfig, overrides: CliOverrides): AppliedOverrides {
  const next = structuredClone(config) as Record<string, unknown>;
  const recorded: Record<string, unknown> = {};

  if (overrides.language !== undefined) {
    next.language = overrides.language;
    recorded.language = overrides.language;
  }
  if (overrides.keywords !== undefined) {
    const keywords = overrides.keywords.split(',').map((keyword) => keyword.trim());
    next.keywords = keywords;
    recorded.keywords = keywords;
  }
  if (overrides.headed === true) {
    const browser = next.browser as Record<string, unknown>;
    browser.headless = false;
    recorded.headed = true;
  }

  const result = xblogConfigSchema.safeParse(next);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    throw new ConfigError(
      'CONFIG_INVALID',
      `Invalid overrides: ${issues.map((issue) => `${issue.path || '<root>'}: ${issue.message}`).join('; ')}`,
      { issues, overrides: recorded },
    );
  }
  return { config: result.data, recorded };
}

function absolute(value: string, baseDir: string): string {
  return isAbsolute(value) ? value : resolve(baseDir, value);
}

/**
 * Resolves every configured path against the config file's directory so the
 * run manifest records absolute paths and the run is independent of cwd.
 */
export function resolveConfigPaths(config: XblogConfig, baseDir: string): XblogConfig {
  return {
    ...config,
    storage: { root: absolute(config.storage.root, baseDir) },
    llm: { ...config.llm, profilesFile: absolute(config.llm.profilesFile, baseDir) },
    browser: {
      ...config.browser,
      firefoxBinary: absolute(config.browser.firefoxBinary, baseDir),
      geckodriverBinary: absolute(config.browser.geckodriverBinary, baseDir),
    },
    auth: {
      ...config.auth,
      profileDir: config.auth.profileDir === null ? null : absolute(config.auth.profileDir, baseDir),
      cookiesFile: config.auth.cookiesFile === null ? null : absolute(config.auth.cookiesFile, baseDir),
    },
  };
}
