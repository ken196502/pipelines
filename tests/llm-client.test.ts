import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { LlmError } from '../src/lib/errors.js';
import type { ResolvedLlmProfile } from '../src/lib/llm/config.js';
import { createOpenAiCompatibleClient } from '../src/lib/llm/openai-compatible.js';
import { JsonlLogger } from '../src/lib/log/jsonl-logger.js';
import { FakeLlmServer, chatCompletion } from './helpers/fake-llm-server.js';
import { cleanupTmpDirs, makeTmpDir } from './helpers/tmp.js';

after(async () => {
  await cleanupTmpDirs();
});

function profileFor(server: FakeLlmServer, overrides: Partial<ResolvedLlmProfile> = {}): ResolvedLlmProfile {
  return {
    name: 'default',
    apiStyle: 'openai-chat',
    baseUrl: server.url,
    baseUrlEnv: 'PIPELINE_TEMPLATE_FAKE_BASE_URL',
    apiKeyEnv: 'PIPELINE_TEMPLATE_FAKE_KEY',
    apiKey: 'sk-test-secret',
    model: 'test-model',
    timeoutMs: 2000,
    maxRetries: 2,
    retryBaseDelayMs: 1,
    ...overrides,
  };
}

async function makeLogger(): Promise<JsonlLogger> {
  const dir = await makeTmpDir('llm');
  return new JsonlLogger({ file: join(dir, 'events.jsonl'), runId: 'r1', pipelineId: 'xblog' });
}

const request = {
  messages: [{ role: 'user' as const, content: 'hi' }],
  maxTokens: 128,
  context: { stage: 'relevance', task: 'score' },
};

describe('createOpenAiCompatibleClient', () => {
  it('returns content and logs request/response without the api key', async (t) => {
    const server = await FakeLlmServer.start();
    t.after(() => server.close());
    const logger = await makeLogger();
    t.after(() => logger.close());

    const client = createOpenAiCompatibleClient(profileFor(server), logger);
    const response = await client.chat(request);
    assert.equal(response.content, 'hello from the fake');
    assert.equal(response.finishReason, 'stop');
    assert.equal(server.requests.length, 1);
    const body = server.requests[0]?.body as Record<string, unknown>;
    assert.equal(body.model, 'test-model');
    assert.equal(body.max_tokens, 128);

    const log = await readFile(logger.file, 'utf8');
    assert.ok(log.includes('llm:request'));
    assert.ok(log.includes('llm:response'));
    assert.ok(!log.includes('sk-test-secret'));
    assert.equal(server.requests[0]?.headers.authorization, 'Bearer sk-test-secret');
  });

  it('does not retry a 400', async (t) => {
    const server = await FakeLlmServer.start((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad request' }));
    });
    t.after(() => server.close());
    const logger = await makeLogger();
    t.after(() => logger.close());

    const client = createOpenAiCompatibleClient(profileFor(server), logger);
    await assert.rejects(client.chat(request), (err: unknown) => {
      assert.ok(err instanceof LlmError);
      assert.equal(err.code, 'LLM_HTTP_ERROR');
      assert.equal(err.status, 400);
      assert.equal(err.retryable, false);
      return true;
    });
    assert.equal(server.requests.length, 1);
  });

  it('retries a 500 maxRetries times and reports attempts', async (t) => {
    const server = await FakeLlmServer.start((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'boom' }));
    });
    t.after(() => server.close());
    const logger = await makeLogger();
    t.after(() => logger.close());

    const client = createOpenAiCompatibleClient(profileFor(server, { maxRetries: 2 }), logger);
    await assert.rejects(client.chat(request), (err: unknown) => {
      assert.ok(err instanceof LlmError);
      assert.equal(err.code, 'LLM_REQUEST_FAILED');
      assert.equal(err.context.attempts, 3);
      assert.equal(err.context.lastStatus, 500);
      assert.equal(err.retryable, true);
      return true;
    });
    assert.equal(server.requests.length, 3);
    const log = await readFile(logger.file, 'utf8');
    assert.equal(log.match(/"event":"llm:retry"/g)?.length, 2);
  });

  it('honours Retry-After on 429', async (t) => {
    const server = await FakeLlmServer.start((_req, res, index) => {
      if (index === 0) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
        res.end(JSON.stringify({ error: 'slow down' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(chatCompletion('after retry')));
    });
    t.after(() => server.close());
    const logger = await makeLogger();
    t.after(() => logger.close());

    const client = createOpenAiCompatibleClient(profileFor(server), logger);
    const response = await client.chat(request);
    assert.equal(response.content, 'after retry');
    assert.equal(server.requests.length, 2);
  });

  it('times out a server that never responds', async (t) => {
    const server = await FakeLlmServer.start(() => {
      // Deliberately never responds.
    });
    t.after(() => server.close());
    const logger = await makeLogger();
    t.after(() => logger.close());

    const client = createOpenAiCompatibleClient(
      profileFor(server, { timeoutMs: 150, maxRetries: 0 }),
      logger,
    );
    await assert.rejects(client.chat(request), (err: unknown) => {
      assert.ok(err instanceof LlmError);
      assert.equal(err.code, 'LLM_REQUEST_FAILED');
      assert.equal(err.context.lastCause, 'timeout');
      return true;
    });
  });

  it('treats finish_reason=length as a failure', async (t) => {
    const server = await FakeLlmServer.start((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(chatCompletion('cut off', 'length')));
    });
    t.after(() => server.close());
    const logger = await makeLogger();
    t.after(() => logger.close());

    const client = createOpenAiCompatibleClient(profileFor(server), logger);
    await assert.rejects(client.chat(request), (err: unknown) => {
      assert.ok(err instanceof LlmError);
      assert.equal(err.code, 'LLM_TRUNCATED');
      return true;
    });
  });

  it('treats empty content as a failure', async (t) => {
    const server = await FakeLlmServer.start((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(chatCompletion('   ')));
    });
    t.after(() => server.close());
    const logger = await makeLogger();
    t.after(() => logger.close());

    const client = createOpenAiCompatibleClient(profileFor(server), logger);
    await assert.rejects(client.chat(request), (err: unknown) => {
      assert.ok(err instanceof LlmError);
      assert.equal(err.code, 'LLM_EMPTY');
      return true;
    });
  });

  it('fails with a malformed response when choices are missing', async (t) => {
    const server = await FakeLlmServer.start((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'fake-model' }));
    });
    t.after(() => server.close());
    const logger = await makeLogger();
    t.after(() => logger.close());

    const client = createOpenAiCompatibleClient(profileFor(server), logger);
    await assert.rejects(client.chat(request), (err: unknown) => {
      assert.ok(err instanceof LlmError);
      assert.equal(err.code, 'LLM_MALFORMED_RESPONSE');
      return true;
    });
  });
});
