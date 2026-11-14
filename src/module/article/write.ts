import { z } from 'zod';
import { PipelineTemplateError } from '../../lib/errors.js';
import { chatJson } from '../../lib/llm/json.js';
import type { ChatContext, LlmClient } from '../../lib/llm/types.js';

export interface ArticleSource {
  tweet: { id: string; url: string; author: string; text: string };
  score: number;
  reason: string;
}

export interface WriteArticleOptions {
  language: 'en' | 'zh';
  sources: ArticleSource[];
  minChars: number;
  maxChars: number;
  maxTokens: number;
  context: ChatContext;
  sink?: (raw: string) => Promise<string>;
}

export interface WrittenArticle {
  title: string;
  body: string;
  imagePrompt: string;
  sourceIds: string[];
}

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
const LATIN = /[A-Za-z]/g;

/**
 * Script-ratio heuristic, documented as a limitation: it counts CJK versus
 * Latin letters and is not a language identifier.
 */
export function scriptRatios(text: string): { cjk: number; latin: number } {
  const cjk = (text.match(CJK) ?? []).length;
  const latin = (text.match(LATIN) ?? []).length;
  const total = cjk + latin;
  if (total === 0) return { cjk: 0, latin: 0 };
  return { cjk: cjk / total, latin: latin / total };
}

function assertLanguage(text: string, language: 'en' | 'zh', context: ChatContext): void {
  const ratios = scriptRatios(text);
  const ok = language === 'zh' ? ratios.cjk >= 0.3 : ratios.latin >= 0.7;
  if (!ok) {
    throw new PipelineTemplateError(
      'ARTICLE_LANGUAGE_MISMATCH',
      `Article was requested in "${language}" but the text is ${Math.round(ratios.cjk * 100)}% CJK / ${Math.round(
        ratios.latin * 100,
      )}% Latin.`,
      { ...context, language, ratios },
    );
  }
}

function sourcesSection(sources: ArticleSource[]): string {
  const lines = sources.map((source) => {
    const handle = source.tweet.author.startsWith('@') ? source.tweet.author : `@${source.tweet.author}`;
    return `- [${handle}](${source.tweet.url})`;
  });
  return `## Sources\n\n${lines.join('\n')}`;
}

/**
 * Writes one article from scored sources. The Sources list is appended from
 * the tweet URLs, so citations never depend on the model.
 */
export async function writeArticle(llm: LlmClient, opts: WriteArticleOptions): Promise<WrittenArticle> {
  if (opts.sources.length === 0) {
    throw new PipelineTemplateError('ARTICLE_NO_SOURCES', 'writeArticle requires at least one source.', {
      ...opts.context,
    });
  }

  const schema = z
    .object({
      title: z.string().min(10).max(100),
      body: z.string().min(opts.minChars).max(opts.maxChars),
      imagePrompt: z.string().min(20).max(600),
      sourceIds: z.array(z.string().min(1)).min(1),
    })
    .strict();

  const payload = {
    language: opts.language,
    length: { minChars: opts.minChars, maxChars: opts.maxChars },
    sources: opts.sources.map((source) => ({
      id: source.tweet.id,
      author: source.tweet.author,
      url: source.tweet.url,
      text: source.tweet.text,
      relevance: source.reason,
    })),
  };

  const article = await chatJson(
    llm,
    {
      messages: [
        {
          role: 'system',
          content:
            'You write a single editorial article from provided social media posts. Reply with JSON only: ' +
            '{"title","body","imagePrompt","sourceIds"}. The body is markdown. Do not invent facts or add sources ' +
            'that are not in the input. imagePrompt describes a cover image and must not contain text overlays. ' +
            `Write in ${opts.language}.`,
        },
        { role: 'user', content: JSON.stringify(payload) },
      ],
      maxTokens: opts.maxTokens,
      context: opts.context,
    },
    schema,
    opts.sink,
  );

  const known = new Map(opts.sources.map((source) => [source.tweet.id, source]));
  const uniqueIds = new Set(article.sourceIds);
  const unknown = article.sourceIds.filter((id) => !known.has(id));
  if (unknown.length > 0 || uniqueIds.size !== article.sourceIds.length) {
    throw new PipelineTemplateError(
      'ARTICLE_SOURCE_IDS_INVALID',
      'Article sourceIds must be unique ids from the provided sources.',
      { ...opts.context, unknown, duplicates: article.sourceIds.filter((id, index) => article.sourceIds.indexOf(id) !== index) },
    );
  }

  assertLanguage(`${article.title}\n${article.body}`, opts.language, opts.context);

  const cited = [...uniqueIds].map((id) => known.get(id)).filter((source): source is ArticleSource => source !== undefined);
  const body = `${article.body.trimEnd()}\n\n${sourcesSection(cited)}`;

  return { title: article.title, body, imagePrompt: article.imagePrompt, sourceIds: [...uniqueIds] };
}
