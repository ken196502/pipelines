import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { z } from 'zod';
import { requireEnv, readJsonConfig } from '../src/lib/config/load.js';
import { ConfigError } from '../src/lib/errors.js';
import { llmConfigSchema, resolveImageProfile, resolveProfile } from '../src/lib/llm/config.js';
import { cleanupTmpDirs, makeTmpDir } from './helpers/tmp.js';

const schema = z
  .object({
    name: z.string().min(1),
    keywords: z.array(z.string().min(1)).min(1),
    nested: z.object({ value: z.number() }).strict(),
  })
  .strict();

after(async () => {
  await cleanupTmpDirs();
});

describe('readJsonConfig', () => {
  it('loads and validates a config file', async () => {
    const dir = await makeTmpDir('config');
    const file = join(dir, 'ok.json');
    await writeFile(file, JSON.stringify({ name: 'x', keywords: ['a'], nested: { value: 1 } }));
    const config = await readJsonConfig(file, schema);
    assert.equal(config.name, 'x');
    assert.deepEqual(config.keywords, ['a']);
  });

  it('fails with CONFIG_NOT_FOUND and the path', async () => {
    const dir = await makeTmpDir('config');
    const file = join(dir, 'missing.json');
    await assert.rejects(readJsonConfig(file, schema), (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.code, 'CONFIG_NOT_FOUND');
      assert.equal(err.context.path, file);
      return true;
    });
  });

  it('fails with CONFIG_PARSE including line and column', async () => {
    const dir = await makeTmpDir('config');
    const file = join(dir, 'bad.json');
    await writeFile(file, '{\n  "name": "x",\n  "keywords": [\n}\n');
    await assert.rejects(readJsonConfig(file, schema), (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.code, 'CONFIG_PARSE');
      assert.equal(typeof err.context.line, 'number');
      assert.equal(typeof err.context.column, 'number');
      return true;
    });
  });

  it('rejects unknown keys instead of ignoring them', async () => {
    const dir = await makeTmpDir('config');
    const file = join(dir, 'typo.json');
    await writeFile(file, JSON.stringify({ name: 'x', keyword: ['a'], keywords: ['a'], nested: { value: 1 } }));
    await assert.rejects(readJsonConfig(file, schema), (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.code, 'CONFIG_INVALID');
      const issues = err.context.issues as Array<{ path: string; message: string }>;
      assert.ok(issues.some((issue) => issue.message.includes('keyword')));
      return true;
    });
  });
});

describe('requireEnv', () => {
  it('returns the value when set', () => {
    process.env.PIPELINE_TEMPLATE_TEST_VALUE = 'secret-value';
    assert.equal(requireEnv('PIPELINE_TEMPLATE_TEST_VALUE'), 'secret-value');
    delete process.env.PIPELINE_TEMPLATE_TEST_VALUE;
  });

  it('fails with ENV_MISSING for a missing variable', () => {
    delete process.env.PIPELINE_TEMPLATE_TEST_MISSING;
    assert.throws(() => requireEnv('PIPELINE_TEMPLATE_TEST_MISSING'), (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.code, 'ENV_MISSING');
      assert.equal(err.context.name, 'PIPELINE_TEMPLATE_TEST_MISSING');
      return true;
    });
  });

  it('treats an empty value as missing', () => {
    process.env.PIPELINE_TEMPLATE_TEST_EMPTY = '   ';
    assert.throws(() => requireEnv('PIPELINE_TEMPLATE_TEST_EMPTY'), (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.code, 'ENV_MISSING');
      return true;
    });
    delete process.env.PIPELINE_TEMPLATE_TEST_EMPTY;
  });
});

describe('LLM profile resolution', () => {
  const validConfig = {
    profiles: {
      default: {
        apiStyle: 'openai-chat' as const,
        baseUrl: 'https://llm.example.test/v1',
        apiKeyEnv: 'PIPELINE_TEMPLATE_TEST_LLM_KEY',
        model: 'real-model',
        timeoutMs: 1000,
        maxRetries: 1,
        retryBaseDelayMs: 1,
      },
    },
    image: {
      apiStyle: 'openai-images' as const,
      baseUrl: 'https://llm.example.test/v1',
      apiKeyEnv: 'PIPELINE_TEMPLATE_TEST_IMAGE_KEY',
      model: 'real-image-model',
      size: '1024x1024',
      timeoutMs: 1000,
      maxRetries: 1,
    },
  };

  it('rejects the committed placeholder gateway and model', () => {
    const config = llmConfigSchema.parse({
      profiles: {
        default: { ...validConfig.profiles.default, baseUrl: 'https://example-gateway/v1', model: 'your-model-id' },
      },
      image: validConfig.image,
    });
    assert.throws(() => resolveProfile(config, 'default'), (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.code, 'LLM_PLACEHOLDER_CONFIG');
      return true;
    });
    assert.throws(() => resolveImageProfile({ ...config, image: { ...config.image, model: 'your-image-model-id' } }), (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.code, 'LLM_PLACEHOLDER_CONFIG');
      return true;
    });
  });

  it('rejects an unknown profile name', () => {
    const config = llmConfigSchema.parse(validConfig);
    assert.throws(() => resolveProfile(config, 'missing'), (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.code, 'LLM_PROFILE_UNKNOWN');
      return true;
    });
  });

  it('requires the configured api key env var', () => {
    const config = llmConfigSchema.parse(validConfig);
    delete process.env.PIPELINE_TEMPLATE_TEST_LLM_KEY;
    assert.throws(() => resolveProfile(config, 'default'), (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.code, 'ENV_MISSING');
      assert.equal(err.context.name, 'PIPELINE_TEMPLATE_TEST_LLM_KEY');
      return true;
    });
  });

  it('resolves a valid profile', () => {
    const config = llmConfigSchema.parse(validConfig);
    process.env.PIPELINE_TEMPLATE_TEST_LLM_KEY = 'sk-test';
    const profile = resolveProfile(config, 'default');
    assert.equal(profile.name, 'default');
    assert.equal(profile.apiKey, 'sk-test');
    assert.equal(profile.model, 'real-model');
    delete process.env.PIPELINE_TEMPLATE_TEST_LLM_KEY;
  });
});
