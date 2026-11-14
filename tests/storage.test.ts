import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { z } from 'zod';
import { StorageError } from '../src/lib/errors.js';
import { writeJsonAtomic } from '../src/lib/fs/atomic.js';
import { assertSafeKey, newRunId } from '../src/lib/ids.js';
import { PipelineStore } from '../src/lib/storage/pipeline-store.js';
import { RunStore } from '../src/lib/storage/run-store.js';
import { cleanupTmpDirs, makeTmpDir } from './helpers/tmp.js';

after(async () => {
  await cleanupTmpDirs();
});

describe('newRunId', () => {
  it('sorts by creation time and has the documented shape', () => {
    const first = newRunId(new Date('2026-01-02T03:04:05.006Z'));
    const second = newRunId(new Date('2026-01-02T03:04:05.007Z'));
    assert.match(first, /^20260102T030405006Z-[0-9a-f]{6}$/);
    assert.ok(first < second);
  });
});

describe('assertSafeKey', () => {
  it('rejects traversal, separators and empty keys', () => {
    for (const key of ['..', '../x', 'a/b', '', 'UPPER', '.hidden', '-dash']) {
      assert.throws(() => assertSafeKey(key), (err: unknown) => {
        assert.ok(err instanceof StorageError);
        assert.equal(err.code, 'STORAGE_UNSAFE_KEY');
        return true;
      });
    }
  });

  it('accepts normal keys', () => {
    assert.equal(assertSafeKey('used-sources'), 'used-sources');
    assert.equal(assertSafeKey('2026.11.13_a'), '2026.11.13_a');
  });
});

describe('writeJsonAtomic', () => {
  it('leaves no temp file on success', async () => {
    const dir = await makeTmpDir('atomic');
    const file = join(dir, 'value.json');
    await writeJsonAtomic(file, { ok: true });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { ok: true });
    assert.deepEqual(await readdir(dir), ['value.json']);
  });

  it('removes the temp file when the rename fails', async () => {
    const dir = await makeTmpDir('atomic');
    const target = join(dir, 'target');
    await mkdir(target);
    await assert.rejects(writeJsonAtomic(target, { ok: false }), (err: unknown) => {
      assert.ok(err instanceof StorageError);
      assert.equal(err.code, 'STORAGE_WRITE_FAILED');
      return true;
    });
    const entries = await readdir(dir);
    assert.deepEqual(entries, ['target']);
  });
});

describe('RunStore', () => {
  it('creates the run directory layout and a manifest', async () => {
    const root = join(await makeTmpDir('runstore'), 'data');
    const store = await RunStore.create(root, 'xblog', 'run-one');
    assert.equal(store.dir, join(root, 'pipelines', 'xblog', 'runs', 'run-one'));
    const manifest = await store.readManifest();
    assert.equal(manifest.status, 'running');
    assert.deepEqual(manifest.stages, []);
  });

  it('rejects a duplicate run id', async () => {
    const root = join(await makeTmpDir('runstore'), 'data');
    await RunStore.create(root, 'xblog', 'dup');
    await assert.rejects(RunStore.create(root, 'xblog', 'dup'), (err: unknown) => {
      assert.ok(err instanceof StorageError);
      assert.equal(err.code, 'RUN_DIR_EXISTS');
      return true;
    });
  });

  it('refuses a storage root in the OS temp directory', async () => {
    await assert.rejects(RunStore.create(tmpdir(), 'xblog', 'nope'), (err: unknown) => {
      assert.ok(err instanceof StorageError);
      assert.equal(err.code, 'STORAGE_ROOT_INVALID');
      return true;
    });
    assert.throws(() => new PipelineStore(tmpdir(), 'xblog'), (err: unknown) => {
      assert.ok(err instanceof StorageError);
      assert.equal(err.code, 'STORAGE_ROOT_INVALID');
      return true;
    });
  });

  it('rejects artifact names with traversal', async () => {
    const root = join(await makeTmpDir('runstore'), 'data');
    const store = await RunStore.create(root, 'xblog', 'run-two');
    assert.throws(() => store.artifactPath('../escape.json'));
    assert.throws(() => store.artifactPath('nested/../../escape.json'));
    assert.equal(store.artifactPath('nested/file.json'), join(store.artifactsDir, 'nested', 'file.json'));
  });

  it('serializes concurrent manifest updates', async () => {
    const root = join(await makeTmpDir('runstore'), 'data');
    const store = await RunStore.create(root, 'xblog', 'run-three');
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.updateManifest({ result: { writer: index }, stages: Array.from({ length: index + 1 }, (_, stage) => ({
          id: `s${stage}`,
          status: 'pending' as const,
        })) }),
      ),
    );
    const manifest = await store.readManifest();
    assert.equal(typeof (manifest.result as { writer: number }).writer, 'number');
    assert.ok(manifest.stages.length >= 1);
    assert.deepEqual(await readdir(store.dir), ['run.json'].sort());
  });

  it('reports a corrupt manifest instead of treating it as empty', async () => {
    const root = join(await makeTmpDir('runstore'), 'data');
    const store = await RunStore.create(root, 'xblog', 'run-four');
    await writeFile(store.manifestPath, '{ not json');
    await assert.rejects(store.readManifest(), (err: unknown) => {
      assert.ok(err instanceof StorageError);
      assert.equal(err.code, 'MANIFEST_CORRUPT');
      return true;
    });
  });
});

describe('PipelineStore', () => {
  const schema = z.object({ ids: z.array(z.string()) }).strict();

  it('round-trips values and lists keys', async () => {
    const root = join(await makeTmpDir('pipelinestore'), 'data');
    const store = new PipelineStore(root, 'xblog');
    await store.writeJson('history', 'used-sources', { ids: ['1', '2'] });
    assert.deepEqual(await store.readJson('history', 'used-sources', schema), { ids: ['1', '2'] });
    assert.deepEqual(await store.listKeys('history'), ['used-sources']);
  });

  it('returns undefined only for a missing file', async () => {
    const root = join(await makeTmpDir('pipelinestore'), 'data');
    const store = new PipelineStore(root, 'xblog');
    assert.equal(await store.readJson('history', 'absent', schema), undefined);
    assert.deepEqual(await store.listKeys('history'), []);
  });

  it('throws on corrupt JSON instead of returning undefined', async () => {
    const root = join(await makeTmpDir('pipelinestore'), 'data');
    const store = new PipelineStore(root, 'xblog');
    const path = store.pathFor('history', 'broken');
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, '{"ids": "not-an-array"}');
    await assert.rejects(store.readJson('history', 'broken', schema), (err: unknown) => {
      assert.ok(err instanceof StorageError);
      assert.equal(err.code, 'STORE_CORRUPT');
      assert.equal(err.context.path, path);
      return true;
    });
  });

  it('rejects unsafe keys before touching the filesystem', async () => {
    const root = join(await makeTmpDir('pipelinestore'), 'data');
    const store = new PipelineStore(root, 'xblog');
    await assert.rejects(store.writeJson('history', '../escape', { ids: [] }), (err: unknown) => {
      assert.ok(err instanceof StorageError);
      assert.equal(err.code, 'STORAGE_UNSAFE_KEY');
      return true;
    });
  });
});
