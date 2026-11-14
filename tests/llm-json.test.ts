import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { z } from 'zod';
import { LlmError } from '../src/lib/errors.js';
import { chatJson } from '../src/lib/llm/json.js';
import type { ChatRequest, LlmClient } from '../src/lib/llm/types.js';
import { cleanupTmpDirs, makeTmpDir } from './helpers/tmp.js';

after(async () => {
  await cleanupTmpDirs();
});

const schema = z.object({ value: z.number().int() }).strict();

const baseRequest: Omit<ChatRequest, 'responseFormat'> = {
  messages: [{ role: 'user', content: 'give me json' }],
  maxTokens: 100,
  context: { stage: 'relevance', task: 'score' },
};

function stubClient(content: string, seen?: ChatRequest[]): LlmClient {
  return {
    async chat(req: ChatRequest) {
      seen?.push(req);
      return { content, model: 'stub', finishReason: 'stop' };
    },
  };
}

describe('chatJson', () => {
  it('accepts raw JSON and requests json_object', async () => {
    const seen: ChatRequest[] = [];
    const result = await chatJson(stubClient('{"value": 7}', seen), baseRequest, schema);
    assert.deepEqual(result, { value: 7 });
    assert.equal(seen[0]?.responseFormat, 'json_object');
  });

  it('accepts a single json fenced block', async () => {
    const result = await chatJson(stubClient('```json\n{"value": 3}\n```'), baseRequest, schema);
    assert.deepEqual(result, { value: 3 });
  });

  it('rejects prose around the JSON', async () => {
    await assert.rejects(chatJson(stubClient('Here is the JSON:\n{"value": 1}'), baseRequest, schema), (err: unknown) => {
      assert.ok(err instanceof LlmError);
      assert.equal(err.code, 'LLM_INVALID_JSON');
      assert.equal(err.context.stage, 'relevance');
      assert.equal(err.context.task, 'score');
      return true;
    });
  });

  it('rejects a schema mismatch and lists the issue paths', async () => {
    await assert.rejects(chatJson(stubClient('{"value": "seven"}'), baseRequest, schema), (err: unknown) => {
      assert.ok(err instanceof LlmError);
      assert.equal(err.code, 'LLM_SCHEMA_MISMATCH');
      const issues = err.context.issues as Array<{ path: string }>;
      assert.deepEqual(
        issues.map((issue) => issue.path),
        ['value'],
      );
      return true;
    });
  });

  it('saves the raw reply through the sink on failure', async () => {
    const dir = await makeTmpDir('llmjson');
    const target = join(dir, 'llm-failures', 'relevance-score.txt');
    const sink = async (raw: string): Promise<string> => {
      await mkdir(join(dir, 'llm-failures'), { recursive: true });
      await writeFile(target, raw, 'utf8');
      return target;
    };
    await assert.rejects(
      chatJson(stubClient('not json at all'), baseRequest, schema, sink),
      (err: unknown) => {
        assert.ok(err instanceof LlmError);
        assert.equal(err.code, 'LLM_INVALID_JSON');
        assert.equal(err.context.rawReplyPath, target);
        return true;
      },
    );
    assert.equal(await readFile(target, 'utf8'), 'not json at all');
  });
});
