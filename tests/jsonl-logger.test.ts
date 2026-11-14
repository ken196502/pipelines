import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { StorageError } from '../src/lib/errors.js';
import { JsonlLogger } from '../src/lib/log/jsonl-logger.js';
import { cleanupTmpDirs, makeTmpDir } from './helpers/tmp.js';

after(async () => {
  await cleanupTmpDirs();
});

function readLines(raw: string): Array<Record<string, unknown>> {
  return raw
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('JsonlLogger', () => {
  it('writes one parseable object per line with increasing seq', async () => {
    const dir = await makeTmpDir('jsonl');
    const file = join(dir, 'events.jsonl');
    const logger = new JsonlLogger({ file, runId: 'r1', pipelineId: 'xblog' });
    logger.info('run:start');
    logger.warn('x:search', { stage: 'x-search', data: { keyword: 'agents' } });
    logger.error('stage:error', { stage: 'article', error: new Error('boom') });
    logger.close();

    const records = readLines(await readFile(file, 'utf8'));
    assert.equal(records.length, 3);
    assert.deepEqual(
      records.map((record) => record.seq),
      [1, 2, 3],
    );
    assert.equal(records[0]?.event, 'run:start');
    assert.equal(records[1]?.stage, 'x-search');
    assert.equal((records[2]?.error as { message: string }).message, 'boom');
    for (const record of records) {
      assert.equal(record.runId, 'r1');
      assert.equal(record.pipelineId, 'xblog');
      assert.equal(typeof record.ts, 'string');
    }
  });

  it('appends on reopen and preserves earlier bytes exactly', async () => {
    const dir = await makeTmpDir('jsonl');
    const file = join(dir, 'events.jsonl');
    const first = new JsonlLogger({ file, runId: 'r1', pipelineId: 'xblog' });
    first.info('run:start');
    first.close();
    const original = await readFile(file, 'utf8');

    const second = new JsonlLogger({ file, runId: 'r1', pipelineId: 'xblog' });
    second.info('run:end');
    second.close();

    const afterBytes = await readFile(file, 'utf8');
    assert.ok(afterBytes.startsWith(original));
    assert.equal(readLines(afterBytes).length, 2);
  });

  it('redacts key-like fields recursively', async () => {
    const dir = await makeTmpDir('jsonl');
    const file = join(dir, 'events.jsonl');
    const logger = new JsonlLogger({ file, runId: 'r1', pipelineId: 'xblog' });
    logger.info('llm:request', {
      data: {
        apiKey: 'sk-secret',
        nested: { Authorization: 'Bearer x', keep: 'visible' },
        items: [{ cookie: 'abc' }],
        api_key: 'other',
        model: 'model-id',
      },
    });
    logger.close();

    const raw = await readFile(file, 'utf8');
    assert.ok(!raw.includes('sk-secret'));
    assert.ok(!raw.includes('Bearer x'));
    assert.ok(!raw.includes('abc'));
    const data = readLines(raw)[0]?.data as Record<string, unknown>;
    assert.equal(data.apiKey, '[redacted]');
    assert.equal((data.nested as Record<string, unknown>).keep, 'visible');
    assert.equal(data.model, 'model-id');
  });

  it('throws LOG_WRITE_FAILED when the log cannot be opened', async () => {
    const dir = await makeTmpDir('jsonl');
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'not a directory');
    assert.throws(
      () => new JsonlLogger({ file: join(blocker, 'events.jsonl'), runId: 'r1', pipelineId: 'xblog' }),
      (err: unknown) => {
        assert.ok(err instanceof StorageError);
        assert.equal(err.code, 'LOG_WRITE_FAILED');
        return true;
      },
    );
  });

  it('throws LOG_WRITE_FAILED after close instead of dropping the record', async () => {
    const dir = await makeTmpDir('jsonl');
    const logger = new JsonlLogger({ file: join(dir, 'events.jsonl'), runId: 'r1', pipelineId: 'xblog' });
    logger.close();
    assert.throws(() => logger.info('run:end'), (err: unknown) => {
      assert.ok(err instanceof StorageError);
      assert.equal(err.code, 'LOG_WRITE_FAILED');
      return true;
    });
  });

  it('refuses to save transcripts unless enabled', async () => {
    const dir = await makeTmpDir('jsonl');
    await mkdir(join(dir, 'artifacts'), { recursive: true });
    const logger = new JsonlLogger({
      file: join(dir, 'events.jsonl'),
      runId: 'r1',
      pipelineId: 'xblog',
      artifactsDir: join(dir, 'artifacts'),
      saveLlmTranscripts: false,
    });
    await assert.rejects(logger.saveLlmTranscript('llm/a.json', { a: 1 }), (err: unknown) => {
      assert.ok(err instanceof StorageError);
      assert.equal(err.code, 'LOG_TRANSCRIPT_DISABLED');
      return true;
    });
    logger.close();
  });
});
