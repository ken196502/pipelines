import { captureEvidence } from '../../lib/browser/evidence.js';
import type { BrowserSession } from '../../lib/browser/firefox.js';
import { PipelineTemplateError } from '../../lib/errors.js';
import { redact } from '../../lib/log/jsonl-logger.js';
import { writeArticle, type ArticleSource } from '../../module/article/write.js';
import { generateImage } from '../../module/image/generate.js';
import { detectPremiumMarker, type PremiumResult } from '../../module/premium/detect.js';
import { scoreCandidates, type ScoredCandidate } from '../../module/relevance/score.js';
import { X_BASE_URL, type Tweet } from '../../module/x/search.js';
import type { FinalizeOutcome, StageContext, StageDefinition } from '../core/types.js';
import type { XblogConfig } from './config.js';
import type { XblogDeps } from './deps.js';
import { readUsedSources, recordDraft } from './history.js';

export interface SelectedSource {
  tweet: Tweet;
  score: number;
  reason: string;
}

export interface XblogState {
  handle?: string;
  candidates?: Tweet[];
  selected?: SelectedSource[];
  article?: { title: string; body: string; imagePrompt: string; sourceIds: string[] };
  image?: { path: string; mime: string; width: number; height: number };
  draft?: { editUrl: string; title: string };
  premium?: { editor: PremiumResult; generated: PremiumResult };
}

type Ctx = StageContext<XblogConfig, XblogDeps>;

function requireSession(deps: XblogDeps): BrowserSession {
  const session = deps.session.current;
  if (!session) {
    throw new PipelineTemplateError(
      'BROWSER_SESSION_LOST',
      'No browser session is open. The browser-launch stage did not run or the session was closed.',
      {},
    );
  }
  return session;
}

function draftOptions(ctx: Ctx) {
  return {
    endpoints: { baseUrl: X_BASE_URL },
    logger: ctx.log,
    evidenceDir: ctx.run.evidenceDir,
    stage: ctx.stageId,
  };
}

function llmSink(ctx: Ctx, name: string): (raw: string) => Promise<string> {
  let counter = 0;
  return (raw: string) => {
    counter += 1;
    return ctx.run.writeArtifact(`llm-failures/${name}-${counter}.txt`, raw);
  };
}

const preflight: StageDefinition<XblogConfig, XblogDeps, XblogState> = {
  id: 'preflight',
  description: 'Validate config, binaries, auth assets and provider profiles without network access',
  async run(ctx) {
    await ctx.deps.preflight();
    // Constructing the clients resolves the profiles, which checks env vars
    // and rejects placeholder values before anything is launched.
    ctx.deps.createLlm(ctx.config.llm.relevance, ctx.log);
    ctx.deps.createLlm(ctx.config.llm.article, ctx.log);
    ctx.deps.createImageClient(ctx.log);

    const path = await ctx.run.writeArtifact('config.resolved.json', redact(ctx.config) as object);
    ctx.recordOutput(path);
    return {};
  },
};

const browserLaunch: StageDefinition<XblogConfig, XblogDeps, XblogState> = {
  id: 'browser-launch',
  description: 'Launch Firefox ESR through geckodriver',
  async run(ctx) {
    const session = await ctx.deps.launchBrowser({
      firefoxBinary: ctx.config.browser.firefoxBinary,
      geckodriverBinary: ctx.config.browser.geckodriverBinary,
      ...(ctx.config.auth.mode === 'profile' && ctx.config.auth.profileDir
        ? { profileDir: ctx.config.auth.profileDir }
        : {}),
      headless: ctx.config.browser.headless,
      windowSize: ctx.config.browser.windowSize,
      ...(ctx.config.browser.proxy ? { proxy: ctx.config.browser.proxy } : {}),
      logDir: ctx.run.webdriverDir,
      pageLoadTimeoutMs: ctx.config.browser.pageLoadTimeoutMs,
      logger: ctx.log,
    });
    ctx.deps.session.current = session;
    return {};
  },
};

const xAuth: StageDefinition<XblogConfig, XblogDeps, XblogState> = {
  id: 'x-auth',
  description: 'Verify the x.com session and read the account handle',
  async run(ctx) {
    const session = requireSession(ctx.deps);
    const { handle } = await ctx.deps.x.ensureLoggedIn(session, {
      mode: ctx.config.auth.mode,
      ...(ctx.config.auth.cookiesFile ? { cookiesFile: ctx.config.auth.cookiesFile } : {}),
      ...(ctx.config.auth.expectedHandle ? { expectedHandle: ctx.config.auth.expectedHandle } : {}),
      logger: ctx.log,
      evidenceDir: ctx.run.evidenceDir,
      stage: ctx.stageId,
      endpoints: { baseUrl: X_BASE_URL },
    });
    const path = await ctx.run.writeArtifact('auth.json', { handle, mode: ctx.config.auth.mode });
    ctx.recordOutput(path);
    return { handle };
  },
};

const xSearch: StageDefinition<XblogConfig, XblogDeps, XblogState> = {
  id: 'x-search',
  description: 'Search every keyword, deduplicate and drop already used sources',
  async run(ctx) {
    const session = requireSession(ctx.deps);
    const used = ctx.config.relevance.excludeUsedSources
      ? new Set(await readUsedSources(ctx.store))
      : new Set<string>();

    const byId = new Map<string, Tweet>();
    const stats: Array<{ keyword: string; tweets: number; dropped: unknown }> = [];

    for (const keyword of ctx.config.keywords) {
      const result = await ctx.deps.x.searchKeyword(session, keyword, {
        feed: ctx.config.search.feed,
        maxTweets: ctx.config.search.tweetsPerKeyword,
        maxScrolls: ctx.config.search.maxScrolls,
        logger: ctx.log,
        stage: ctx.stageId,
        endpoints: { baseUrl: X_BASE_URL },
        evidenceDir: ctx.run.evidenceDir,
      });
      stats.push({ keyword, tweets: result.tweets.length, dropped: result.dropped });
      for (const tweet of result.tweets) {
        if (used.has(tweet.id)) continue;
        byId.set(tweet.id, tweet);
      }
    }

    const candidates = [...byId.values()];
    const candidatesPath = await ctx.run.writeArtifact('candidates.json', { candidates });
    const statsPath = await ctx.run.writeArtifact('search-stats.json', {
      keywords: stats,
      usedExcluded: used.size,
      candidates: candidates.length,
    });
    ctx.recordOutput(candidatesPath);
    ctx.recordOutput(statsPath);

    if (candidates.length === 0) {
      throw new PipelineTemplateError(
        'XBLOG_NO_CANDIDATES',
        `No new posts were found for ${ctx.config.keywords.length} keyword(s).`,
        { keywords: ctx.config.keywords, usedExcluded: used.size },
      );
    }
    return { candidates };
  },
};

const relevance: StageDefinition<XblogConfig, XblogDeps, XblogState> = {
  id: 'relevance',
  description: 'Score candidates with the LLM and select the best sources',
  async run(ctx, state) {
    const candidates = state.candidates ?? [];
    const llm = ctx.deps.createLlm(ctx.config.llm.relevance, ctx.log);
    const scores: ScoredCandidate[] = await scoreCandidates(llm, {
      topicKeywords: ctx.config.keywords,
      language: ctx.config.language,
      candidates: candidates.map((tweet) => ({
        id: tweet.id,
        text: tweet.text,
        author: tweet.author,
        url: tweet.url,
      })),
      maxTokens: ctx.config.relevance.maxTokens,
      batchSize: ctx.config.relevance.batchSize,
      context: { stage: ctx.stageId, task: 'score' },
      sink: llmSink(ctx, 'relevance-score'),
    });

    const byId = new Map(candidates.map((tweet) => [tweet.id, tweet]));
    const selected: SelectedSource[] = scores
      .filter((score) => score.score >= ctx.config.relevance.minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, ctx.config.relevance.maxSources)
      .map((score) => ({ tweet: byId.get(score.id) as Tweet, score: score.score, reason: score.reason }));

    const scoresPath = await ctx.run.writeArtifact('scores.json', { scores });
    const selectedPath = await ctx.run.writeArtifact('selected.json', { selected });
    ctx.recordOutput(scoresPath);
    ctx.recordOutput(selectedPath);

    if (selected.length === 0) {
      const bestScore = scores.reduce((best, item) => Math.max(best, item.score), 0);
      throw new PipelineTemplateError(
        'XBLOG_NO_RELEVANT_SOURCES',
        `No candidate reached minScore ${ctx.config.relevance.minScore} (best score ${bestScore}).`,
        { minScore: ctx.config.relevance.minScore, bestScore, candidates: candidates.length },
      );
    }
    return { selected };
  },
};

const article: StageDefinition<XblogConfig, XblogDeps, XblogState> = {
  id: 'article',
  description: 'Write the article from the selected sources',
  async run(ctx, state) {
    const selected = state.selected ?? [];
    const sources: ArticleSource[] = selected.map((item) => ({
      tweet: item.tweet,
      score: item.score,
      reason: item.reason,
    }));
    const llm = ctx.deps.createLlm(ctx.config.llm.article, ctx.log);
    const written = await writeArticle(llm, {
      language: ctx.config.language,
      sources,
      minChars: ctx.config.article.minChars,
      maxChars: ctx.config.article.maxChars,
      maxTokens: ctx.config.article.maxTokens,
      context: { stage: ctx.stageId, task: 'write' },
      sink: llmSink(ctx, 'article'),
    });

    const articlePath = await ctx.run.writeArtifact('article.json', written);
    const markdownPath = await ctx.run.writeArtifact('article.md', written.body);
    ctx.recordOutput(articlePath);
    ctx.recordOutput(markdownPath);
    return { article: written };
  },
};

const image: StageDefinition<XblogConfig, XblogDeps, XblogState> = {
  id: 'image',
  description: 'Generate and validate the cover image',
  async run(ctx, state) {
    const written = state.article;
    if (!written) {
      throw new PipelineTemplateError('XBLOG_NO_ARTICLE', 'The image stage ran without an article.', {});
    }
    const client = ctx.deps.createImageClient(ctx.log);
    const generated = await generateImage(client, written.imagePrompt, ctx.run.artifactPath('cover'), {
      stage: ctx.stageId,
      task: 'cover',
    });
    ctx.recordOutput(generated.path);
    return { image: { path: generated.path, mime: generated.mime, width: generated.width, height: generated.height } };
  },
};

const draftCompose: StageDefinition<XblogConfig, XblogDeps, XblogState> = {
  id: 'draft-compose',
  description: 'Open the X Articles editor and compose title, body and cover',
  async run(ctx, state) {
    const session = requireSession(ctx.deps);
    const written = state.article;
    const cover = state.image;
    if (!written || !cover) {
      throw new PipelineTemplateError('XBLOG_NO_ARTICLE', 'The draft stage ran without an article or cover.', {});
    }
    const { editUrl } = await ctx.deps.x.draft.openArticleDraft(session, draftOptions(ctx));
    await ctx.deps.x.draft.setTitle(session, written.title);
    await ctx.deps.x.draft.setBody(session, written.body);
    await ctx.deps.x.draft.attachCoverImage(session, cover.path);

    await captureEvidence(session, ctx.run.evidenceDir, 'draft-composed', ctx.log);
    const path = await ctx.run.writeArtifact('draft.json', {
      editUrl,
      title: written.title,
      bodyChars: written.body.length,
    });
    ctx.recordOutput(path);
    return { draft: { editUrl, title: written.title } };
  },
};

const premiumCheck: StageDefinition<XblogConfig, XblogDeps, XblogState> = {
  id: 'premium-check',
  description: 'Detect the configured Premium marker in the editor and in the generated text',
  async run(ctx, state) {
    const session = requireSession(ctx.deps);
    const written = state.article;
    if (!written) {
      throw new PipelineTemplateError('XBLOG_NO_ARTICLE', 'The premium stage ran without an article.', {});
    }
    const editorText = await ctx.deps.x.draft.readLeadingText(session, 500);
    const editor = detectPremiumMarker(editorText, ctx.config.premium.markers);
    const generated = detectPremiumMarker(`${written.title}\n${written.body}`, ctx.config.premium.markers);

    const path = await ctx.run.writeArtifact('premium.json', { editor, generated });
    ctx.recordOutput(path);
    return { premium: { editor, generated } };
  },
};

const draftSave: StageDefinition<XblogConfig, XblogDeps, XblogState> = {
  id: 'draft-save',
  description: 'Wait for autosave, verify the draft is listed and record history',
  async run(ctx, state) {
    const session = requireSession(ctx.deps);
    const written = state.article;
    if (!written) {
      throw new PipelineTemplateError('XBLOG_NO_ARTICLE', 'The save stage ran without an article.', {});
    }
    const premium = state.premium;
    if (!premium) {
      throw new PipelineTemplateError('XBLOG_NO_PREMIUM_RESULT', 'The save stage ran without a premium result.', {});
    }

    await ctx.deps.x.draft.waitForSaved(session, ctx.config.draft.saveTimeoutMs);
    const editUrl = await ctx.deps.x.draft.verifyDraftListed(session, written.title, draftOptions(ctx));

    await recordDraft(
      ctx.store,
      {
        runId: ctx.run.runId,
        editUrl,
        sourceIds: written.sourceIds,
        title: written.title,
        premium: {
          detected: premium.editor.detected,
          ...(premium.editor.marker ? { marker: premium.editor.marker } : {}),
        },
      },
      written.sourceIds,
    );

    const path = await ctx.run.writeArtifact('draft.json', {
      editUrl,
      title: written.title,
      bodyChars: written.body.length,
      verifiedAt: new Date().toISOString(),
    });
    ctx.recordOutput(path);
    return { draft: { editUrl, title: written.title } };
  },
};

export const xblogStages: readonly StageDefinition<XblogConfig, XblogDeps, XblogState>[] = [
  preflight,
  browserLaunch,
  xAuth,
  xSearch,
  relevance,
  article,
  image,
  draftCompose,
  premiumCheck,
  draftSave,
];

/**
 * Closes the browser and records the run result. Close problems are logged as
 * warnings and never replace a stage error.
 */
export async function finalizeXblog(
  ctx: StageContext<XblogConfig, XblogDeps>,
  state: XblogState,
  outcome: FinalizeOutcome,
): Promise<void> {
  const session = ctx.deps.session.current;
  let closeReport: unknown = null;
  if (session) {
    try {
      closeReport = await session.close();
    } catch (err) {
      ctx.log.warn('browser:close-error', { stage: 'finalize', error: err });
    }
    ctx.deps.session.current = null;
  }

  await ctx.run.updateManifest({
    result: {
      outcome: outcome.status,
      handle: state.handle ?? null,
      draftUrl: state.draft?.editUrl ?? null,
      sourceIds: state.article?.sourceIds ?? [],
      premium: state.premium ?? null,
      closeReport,
    },
  });
}
