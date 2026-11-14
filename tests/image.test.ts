import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ImageError } from '../src/lib/errors.js';
import { createOpenAiImageClient } from '../src/lib/image/openai-images.js';
import { validateImageBytes } from '../src/lib/image/validate.js';
import type { ResolvedImageProfile } from '../src/lib/llm/config.js';
import { JsonlLogger } from '../src/lib/log/jsonl-logger.js';
import { FakeLlmServer } from './helpers/fake-llm-server.js';
import { cleanupTmpDirs, makeTmpDir } from './helpers/tmp.js';

after(async () => {
  await cleanupTmpDirs();
});

/** A buffer with a real PNG signature and IHDR dimensions, padded past 1 KB. */
function fakePng(width = 64, height = 48, total = 2048): Buffer {
  const buf = Buffer.alloc(total, 0x20);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function profileFor(server: FakeLlmServer): ResolvedImageProfile {
  return {
    apiStyle: 'openai-images',
    baseUrl: server.url,
    apiKeyEnv: 'PIPELINE_TEMPLATE_FAKE_IMAGE_KEY',
    apiKey: 'sk-image-secret',
    model: 'test-image-model',
    size: '1536x1024',
    timeoutMs: 2000,
    maxRetries: 1,
  };
}

async function makeLogger(): Promise<JsonlLogger> {
  const dir = await makeTmpDir('image');
  return new JsonlLogger({ file: join(dir, 'events.jsonl'), runId: 'r1', pipelineId: 'xblog' });
}

describe('validateImageBytes', () => {
  it('accepts a PNG and reports its dimensions', () => {
    const info = validateImageBytes(fakePng(64, 48));
    assert.equal(info.mime, 'image/png');
    assert.equal(info.width, 64);
    assert.equal(info.height, 48);
  });

  it('rejects bytes that are not an image', () => {
    assert.throws(() => validateImageBytes(Buffer.alloc(4096, 0x41)), (err: unknown) => {
      assert.ok(err instanceof ImageError);
      assert.equal(err.code, 'IMAGE_INVALID_BYTES');
      return true;
    });
  });

  it('rejects images smaller than 1 KB', () => {
    assert.throws(() => validateImageBytes(fakePng(64, 48, 100)), (err: unknown) => {
      assert.ok(err instanceof ImageError);
      assert.equal(err.code, 'IMAGE_INVALID_BYTES');
      return true;
    });
  });
});

describe('createOpenAiImageClient', () => {
  const png = fakePng();

  it('decodes b64_json responses', async (t) => {
    const server = await FakeLlmServer.start((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
    });
    t.after(() => server.close());
    const logger = await makeLogger();
    t.after(() => logger.close());

    const client = createOpenAiImageClient(profileFor(server), logger);
    const result = await client.generate({ prompt: 'a cover image', context: { stage: 'image', task: 'cover' } });
    assert.ok(result.bytes.equals(png));
    const body = server.requests[0]?.body as Record<string, unknown>;
    assert.equal(body.size, '1536x1024');
    assert.equal(body.response_format, 'b64_json');
  });

  it('downloads url responses', async (t) => {
    const server = await FakeLlmServer.start((req, res) => {
      if (req.path === '/image.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(png);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ url: `${server.url}/image.png` }] }));
    });
    t.after(() => server.close());
    const logger = await makeLogger();
    t.after(() => logger.close());

    const client = createOpenAiImageClient(profileFor(server), logger);
    const result = await client.generate({ prompt: 'a cover image', context: { stage: 'image', task: 'cover' } });
    assert.ok(result.bytes.equals(png));
    assert.equal(server.requests.length, 2);
  });

  it('fails with IMAGE_EMPTY_RESPONSE when data is missing', async (t) => {
    const server = await FakeLlmServer.start((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    });
    t.after(() => server.close());
    const logger = await makeLogger();
    t.after(() => logger.close());

    const client = createOpenAiImageClient(profileFor(server), logger);
    await assert.rejects(
      client.generate({ prompt: 'a cover image', context: { stage: 'image', task: 'cover' } }),
      (err: unknown) => {
        assert.ok(err instanceof ImageError);
        assert.equal(err.code, 'IMAGE_EMPTY_RESPONSE');
        return true;
      },
    );
  });
});
