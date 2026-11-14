import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { PipelineTemplateError } from '../src/lib/errors.js';
import type { ResolvedLlmProfile } from '../src/lib/llm/config.js';
import { createOpenAiCompatibleClient } from '../src/lib/llm/openai-compatible.js';
import type { JsonlLogger } from '../src/lib/log/jsonl-logger.js';
import { PipelineStore } from '../src/lib/storage/pipeline-store.js';
import { runPipeline } from '../src/pipeline/core/runner.js';
import { xblogPipeline } from '../src/pipeline/xblog/index.js';
import type { XblogConfig } from '../src/pipeline/xblog/config.js';
import { draftsSchema, usedSourcesSchema } from '../src/pipeline/xblog/history.js';
import type { Tweet } from '../src/module/x/search.js';
import { createFakeDeps, type FakeXCalls } from './helpers/fake-x.js';
import { FakeLlmServer, chatCompletion, type FakeHandler } from './helpers/fake-llm-server.js';
import { cleanupTmpDirs, makeTmpDir } from './helpers/tmp.js';

after(async () => {
  await cleanupTmpDirs();
});

const TWEETS: Tweet[] = [
  {
    id: '1001',
    url: 'https://x.com/alice/status/1001',
    author: 'alice',
    createdAt: '2026-11-01T10:00:00.000Z',
    text: 'Agent orchestration patterns are consolidating around tool-using loops.',
  },
  {
    id: '1002',
    url: 'https://x.com/bob/status/1002',
    author: 'bob',
    createdAt: '2026-11-01T11:00:00.000Z',
    text: 'A practical write-up on agent memory and retrieval.',
  },
];

function fakePng(total = 2048): Buffer {
  const buffer = Buffer.alloc(total, 0x20);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(64, 16);
  buffer.writeUInt32BE(48, 20);
  return buffer;
}

interface Scenario {
  tweets?: Tweet[];
  keywords?: string[];
  language?: 'en' | 'zh';
  blockOnKeyword?: string;
  selectorMissingOnKeyword?: string;
  authError?: 'X_AUTH_REQUIRED' | 'X_CHALLENGE' | 'X_AUTH_WRONG_ACCOUNT';
  articlesUnavailable?: boolean;
  draftNotSaved?: boolean;
  premiumText?: string;
  imageBytes?: Buffer;
  scoreValue?: number;
  wrongScoreIds?: boolean;
  usedSources?: string[];
  closeLlmServer?: boolean;
}

interface ScenarioResult {
  dir: string;
  config: XblogConfig;
  calls: FakeXCalls;
  runId: string;
  runDir: string;
  error?: PipelineTemplateError;
  requests: Array<Record<string, unknown>>;
}

let runCounter = 0;

function baseConfig(dir: string, scenario: Scenario): XblogConfig {
  return {
    language: scenario.language ?? 'en',
    keywords: scenario.keywords ?? ['agents'],
    storage: { root: join(dir, 'data') },
    llm: { profilesFile: join(dir, 'llm.json'), relevance: 'default', article: 'default' },
    browser: {
      firefoxBinary: '/usr/bin/firefox-esr',
      geckodriverBinary: join(dir, 'geckodriver'),
      headless: true,
      windowSize: { width: 800, height: 600 },
      pageLoadTimeoutMs: 1000,
      proxy: null,
    },
    auth: { mode: 'profile', profileDir: join(dir, 'profile'), cookiesFile: null, expectedHandle: null },
    search: { feed: 'top', tweetsPerKeyword: 5, maxScrolls: 1, useLangOperator: false },
    relevance: { minScore: 5, maxSources: 2, batchSize: 20, maxTokens: 100, excludeUsedSources: true },
    article: { minChars: 40, maxChars: 4000, maxTokens: 200 },
    premium: { markers: ['[Premium]'] },
    draft: { saveTimeoutMs: 1000 },
    logging: { saveLlmTranscripts: false },
  };
}

function handlerFor(scenario: Scenario): FakeHandler {
  return (req, res) => {
    const body = req.body as { messages: Array<{ content: string }> };
    const system = body.messages[0]?.content ?? '';
    const user = JSON.parse(body.messages[1]?.content ?? '{}') as {
      candidates?: Array<{ id: string }>;
      sources?: Array<{ id: string }>;
    };
    res.writeHead(200, { 'content-type': 'application/json' });

    if (system.includes('rank social media posts')) {
      const scores = (user.candidates ?? []).map((candidate) => ({
        id: scenario.wrongScoreIds ? `${candidate.id}-wrong` : candidate.id,
        score: scenario.scoreValue ?? 8,
        reason: 'Directly relevant to the configured topic.',
      }));
      res.end(JSON.stringify(chatCompletion(JSON.stringify({ scores }))));
      return;
    }

    if (system.includes('editorial article')) {
      const zh = scenario.language === 'zh';
      const article = {
        title: zh ? '智能体系统的实践与未来' : 'Agent systems in practice',
        body: zh
          ? '智能体系统正在改变团队构建软件的方式。'.repeat(4)
          : 'Agent systems are changing how teams build software. '.repeat(4),
        imagePrompt: 'A clean editorial cover illustration of connected agents, no text.',
        sourceIds: (user.sources ?? []).slice(0, 2).map((source) => source.id),
      };
      res.end(JSON.stringify(chatCompletion(JSON.stringify(article))));
      return;
    }

    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unexpected prompt' }));
  };
}

function llmProfile(baseUrl: string): ResolvedLlmProfile {
  return {
    name: 'default',
    apiStyle: 'openai-chat',
    baseUrl,
    apiKeyEnv: 'UNUSED_IN_TESTS',
    apiKey: 'test-key',
    model: 'test-model',
    timeoutMs: 2000,
    maxRetries: 0,
    retryBaseDelayMs: 1,
  };
}

async function runScenario(scenario: Scenario = {}): Promise<ScenarioResult> {
  const dir = await makeTmpDir('xblog');
  const config = baseConfig(dir, scenario);
  const server = await FakeLlmServer.start(handlerFor(scenario));
  let serverClosed = false;
  if (scenario.closeLlmServer) {
    await server.close();
    serverClosed = true;
  }

  const { deps, calls } = createFakeDeps({
    tweets: scenario.tweets ?? TWEETS,
    ...(scenario.blockOnKeyword ? { blockOnKeyword: scenario.blockOnKeyword } : {}),
    ...(scenario.selectorMissingOnKeyword ? { selectorMissingOnKeyword: scenario.selectorMissingOnKeyword } : {}),
    ...(scenario.authError ? { authError: scenario.authError } : {}),
    ...(scenario.articlesUnavailable ? { articlesUnavailable: true } : {}),
    ...(scenario.draftNotSaved ? { draftNotSaved: true } : {}),
    ...(scenario.premiumText ? { premiumText: scenario.premiumText } : {}),
    imageBytes: scenario.imageBytes ?? fakePng(),
    llm: (logger: JsonlLogger) => createOpenAiCompatibleClient(llmProfile(server.url), logger),
  });

  if (scenario.usedSources) {
    const store = new PipelineStore(config.storage.root, 'xblog');
    await store.writeJson('history', 'used-sources', { ids: scenario.usedSources } satisfies { ids: string[] });
  }

  const configPath = join(dir, 'xblog.json');
  await writeFile(configPath, JSON.stringify(config), 'utf8');

  runCounter += 1;
  const runId = `run-${runCounter}`;
  const runDir = join(config.storage.root, 'pipelines', 'xblog', 'runs', runId);

  let error: PipelineTemplateError | undefined;
  try {
    await runPipeline({
      definition: xblogPipeline,
      configPath,
      config,
      overrides: {},
      deps,
      storageRoot: config.storage.root,
      runId,
    });
  } catch (err) {
    assert.ok(err instanceof PipelineTemplateError, `expected a typed error, got ${String(err)}`);
    error = err;
  } finally {
    if (!serverClosed) await server.close();
  }

  return {
    dir,
    config,
    calls,
    runId,
    runDir,
    ...(error ? { error } : {}),
    requests: server.requests.map((request) => request.body as Record<string, unknown>),
  };
}

async function readManifest(runDir: string) {
  return JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')) as {
    status: string;
    stages: Array<{ id: string; status: string }>;
    error?: { code: string };
    result?: { draftUrl?: string | null };
  };
}

async function readArtifact<T>(runDir: string, name: string): Promise<T> {
  return JSON.parse(await readFile(join(runDir, 'artifacts', name), 'utf8')) as T;
}

async function historyDrafts(root: string): Promise<unknown[] | undefined> {
  const store = new PipelineStore(root, 'xblog');
  const value = await store.readJson('history', 'drafts', draftsSchema);
  return value?.drafts;
}

describe('xblog orchestration', () => {
  it('runs all ten stages, writes artifacts, and records history', async () => {
    const result = await runScenario({ premiumText: '[Premium] Lead paragraph' });
    assert.equal(result.error, undefined);

    const manifest = await readManifest(result.runDir);
    assert.equal(manifest.status, 'succeeded');
    assert.deepEqual(
      manifest.stages.map((stage) => [stage.id, stage.status]),
      [
        ['preflight', 'succeeded'],
        ['browser-launch', 'succeeded'],
        ['x-auth', 'succeeded'],
        ['x-search', 'succeeded'],
        ['relevance', 'succeeded'],
        ['article', 'succeeded'],
        ['image', 'succeeded'],
        ['draft-compose', 'succeeded'],
        ['premium-check', 'succeeded'],
        ['draft-save', 'succeeded'],
      ],
    );

    for (const artifact of [
      'config.resolved.json',
      'auth.json',
      'candidates.json',
      'search-stats.json',
      'scores.json',
      'selected.json',
      'article.json',
      'article.md',
      'cover.png',
      'draft.json',
      'premium.json',
    ]) {
      await readFile(join(result.runDir, 'artifacts', artifact), 'utf8');
    }

    const premium = await readArtifact<{ editor: { detected: boolean }; generated: { detected: boolean } }>(
      result.runDir,
      'premium.json',
    );
    assert.equal(premium.editor.detected, true);
    assert.equal(premium.generated.detected, false);

    const drafts = await historyDrafts(result.config.storage.root);
    assert.equal(drafts?.length, 1);
    const used = await new PipelineStore(result.config.storage.root, 'xblog').readJson(
      'history',
      'used-sources',
      usedSourcesSchema,
    );
    assert.deepEqual(used?.ids.sort(), ['1001', '1002']);
    assert.equal(result.calls.closed, 1);
    assert.equal(result.calls.published, 0);
    assert.equal(manifest.result?.draftUrl, 'https://x.com/compose/articles/fake-1');
  });

  it('records a not-detected premium result', async () => {
    const result = await runScenario({ premiumText: 'A normal draft' });
    const premium = await readArtifact<{ editor: { detected: boolean } }>(result.runDir, 'premium.json');
    assert.equal(premium.editor.detected, false);
  });

  it('passes configured keywords to search and the language to the article prompt', async () => {
    const result = await runScenario({ keywords: ['alpha', 'beta'], language: 'zh' });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.calls.searches, ['alpha', 'beta']);

    const scoreRequest = result.requests.find((body) => {
      const messages = body.messages as Array<{ content: string }>;
      return (messages[0]?.content ?? '').includes('rank social media posts');
    });
    assert.ok(scoreRequest);
    const scoreUser = JSON.parse((scoreRequest.messages as Array<{ content: string }>)[1]?.content ?? '{}') as {
      topic: string[];
    };
    assert.deepEqual(scoreUser.topic, ['alpha', 'beta']);

    const articleRequest = result.requests.find((body) => {
      const messages = body.messages as Array<{ content: string }>;
      return (messages[0]?.content ?? '').includes('editorial article');
    });
    assert.ok(articleRequest);
    const articleSystem = (articleRequest.messages as Array<{ content: string }>)[0]?.content ?? '';
    assert.ok(articleSystem.includes('Write in zh'));
  });

  it('filters sources already recorded as used', async () => {
    const result = await runScenario({ usedSources: ['1001'] });
    assert.equal(result.error, undefined);
    const candidates = await readArtifact<{ candidates: Tweet[] }>(result.runDir, 'candidates.json');
    assert.deepEqual(
      candidates.candidates.map((tweet) => tweet.id),
      ['1002'],
    );
  });

  async function assertFailure(result: ScenarioResult, code: string, failedStage: string) {
    assert.equal(result.error?.code, code);
    const manifest = await readManifest(result.runDir);
    assert.equal(manifest.status, 'failed');
    const index = manifest.stages.findIndex((stage) => stage.id === failedStage);
    assert.ok(index >= 0, `stage ${failedStage} must exist`);
    assert.equal(manifest.stages[index]?.status, 'failed');
    for (const stage of manifest.stages.slice(index + 1)) {
      assert.equal(stage.status, 'not-run', `${stage.id} must be not-run`);
    }
    assert.equal(result.calls.closed, 1, 'the browser must be closed exactly once');
    assert.equal(await historyDrafts(result.config.storage.root), undefined, 'no history on failure');
  }

  it('fails at x-auth with X_AUTH_REQUIRED', async () => {
    const result = await runScenario({ authError: 'X_AUTH_REQUIRED' });
    await assertFailure(result, 'X_AUTH_REQUIRED', 'x-auth');
  });

  it('fails the whole search when the second keyword is blocked', async () => {
    const result = await runScenario({ keywords: ['alpha', 'beta'], blockOnKeyword: 'beta' });
    assert.deepEqual(result.calls.searches, ['alpha', 'beta']);
    await assertFailure(result, 'X_SEARCH_BLOCKED', 'x-search');
  });

  it('fails with X_SELECTOR_MISSING on DOM drift', async () => {
    const result = await runScenario({ selectorMissingOnKeyword: 'agents' });
    await assertFailure(result, 'X_SELECTOR_MISSING', 'x-search');
  });

  it('fails at relevance when the LLM is unreachable', async () => {
    const result = await runScenario({ closeLlmServer: true });
    await assertFailure(result, 'LLM_REQUEST_FAILED', 'relevance');
  });

  it('fails at relevance when the score id set is wrong', async () => {
    const result = await runScenario({ wrongScoreIds: true });
    await assertFailure(result, 'LLM_SCORE_SET_MISMATCH', 'relevance');
  });

  it('fails with XBLOG_NO_CANDIDATES when nothing is found', async () => {
    const result = await runScenario({ tweets: [] });
    await assertFailure(result, 'XBLOG_NO_CANDIDATES', 'x-search');
  });

  it('fails with XBLOG_NO_RELEVANT_SOURCES and reports the best score', async () => {
    const result = await runScenario({ scoreValue: 1 });
    assert.equal(result.error?.context.bestScore, 1);
    await assertFailure(result, 'XBLOG_NO_RELEVANT_SOURCES', 'relevance');
  });

  it('fails at image with IMAGE_INVALID_BYTES', async () => {
    const result = await runScenario({ imageBytes: Buffer.alloc(4096, 0x41) });
    await assertFailure(result, 'IMAGE_INVALID_BYTES', 'image');
  });

  it('fails at draft-compose with X_ARTICLES_UNAVAILABLE', async () => {
    const result = await runScenario({ articlesUnavailable: true });
    await assertFailure(result, 'X_ARTICLES_UNAVAILABLE', 'draft-compose');
  });

  it('fails at draft-save with X_DRAFT_NOT_SAVED', async () => {
    const result = await runScenario({ draftNotSaved: true });
    await assertFailure(result, 'X_DRAFT_NOT_SAVED', 'draft-save');
  });
});
