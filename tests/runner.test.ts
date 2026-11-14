import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { z } from 'zod';
import { PipelineTemplateError, XError } from '../src/lib/errors.js';
import { runPipeline } from '../src/pipeline/core/runner.js';
import type { PipelineDefinition, StageContext } from '../src/pipeline/core/types.js';
import { cleanupTmpDirs, makeTmpDir } from './helpers/tmp.js';

after(async () => {
  await cleanupTmpDirs();
});

interface TestState {
  order: string[];
}

interface TestDeps {
  failAt?: string;
  finalizeError?: boolean;
  finalizeCalls: Array<{ status: string; errorCode?: string }>;
}

const configSchema = z.object({ marker: z.string() }).strict();

function definition(deps: TestDeps): PipelineDefinition<{ marker: string }, TestDeps, TestState> {
  return {
    id: 'testpipeline',
    configSchema,
    stages: [
      {
        id: 'one',
        description: 'first',
        async run(_ctx: StageContext<{ marker: string }, TestDeps>, state: TestState) {
          return { order: [...(state.order ?? []), 'one'] };
        },
      },
      {
        id: 'two',
        description: 'second',
        async run(_ctx: StageContext<{ marker: string }, TestDeps>, state: TestState) {
          if (deps.failAt === 'two') {
            throw new XError('X_SELECTOR_MISSING', 'tweet selector missing', { selector: 'tweet' });
          }
          return { order: [...state.order, 'two'] };
        },
      },
      {
        id: 'three',
        description: 'third',
        async run(_ctx: StageContext<{ marker: string }, TestDeps>, state: TestState) {
          if (deps.failAt === 'three') {
            throw new XError('X_DRAFT_NOT_SAVED', 'draft not saved', {});
          }
          return { order: [...state.order, 'three'] };
        },
      },
    ],
    async finalize(_ctx, _state, outcome) {
      deps.finalizeCalls.push({ status: outcome.status, ...(outcome.error ? { errorCode: outcome.error.code } : {}) });
      if (deps.finalizeError) {
        throw new Error('finalize exploded');
      }
    },
  };
}

async function setup(runId: string) {
  const dir = await makeTmpDir('runner');
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ marker: 'value' }));
  const storageRoot = join(dir, 'data');
  return {
    configPath,
    storageRoot,
    runDir: join(storageRoot, 'pipelines', 'testpipeline', 'runs', runId),
  };
}

async function readManifest(runDir: string) {
  return JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')) as {
    status: string;
    stages: Array<{ id: string; status: string; durationMs?: number; outputs?: string[] }>;
    error?: { code: string };
  };
}

describe('runPipeline', () => {
  it('runs stages in order, accumulates state and records the manifest', async () => {
    const deps: TestDeps = { finalizeCalls: [] };
    const ctx = await setup('run-test');
    const outcome = await runPipeline({
      definition: definition(deps),
      configPath: ctx.configPath,
      config: { marker: 'value' },
      overrides: { marker: 'value' },
      deps,
      storageRoot: ctx.storageRoot,
      runId: 'run-test',
    });

    assert.deepEqual(outcome.state.order, ['one', 'two', 'three']);
    assert.equal(deps.finalizeCalls.length, 1);
    assert.equal(deps.finalizeCalls[0]?.status, 'succeeded');

    const manifest = await readManifest(ctx.runDir);
    assert.equal(manifest.status, 'succeeded');
    assert.deepEqual(
      manifest.stages.map((stage) => [stage.id, stage.status]),
      [
        ['one', 'succeeded'],
        ['two', 'succeeded'],
        ['three', 'succeeded'],
      ],
    );
    for (const stage of manifest.stages) {
      assert.equal(typeof stage.durationMs, 'number');
      assert.ok((stage.outputs ?? []).some((output) => output.endsWith(`state-${stage.id}.json`)));
    }

    const events = (await readFile(join(ctx.runDir, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event: string; stage?: string; seq: number });
    assert.equal(events[0]?.event, 'run:start');
    assert.equal(events.at(-1)?.event, 'run:end');
    const stageEvents = events.filter((event) => event.event.startsWith('stage:'));
    assert.deepEqual(
      stageEvents.map((event) => `${event.event}:${event.stage}`),
      [
        'stage:start:one',
        'stage:end:one',
        'stage:start:two',
        'stage:end:two',
        'stage:start:three',
        'stage:end:three',
      ],
    );
    assert.deepEqual(
      events.map((event) => event.seq),
      events.map((_, index) => index + 1),
    );
  });

  it('marks later stages not-run and rethrows the original error', async () => {
    const deps: TestDeps = { failAt: 'two', finalizeCalls: [] };
    const ctx = await setup('run-failed');
    await assert.rejects(
      runPipeline({
        definition: definition(deps),
        configPath: ctx.configPath,
        config: { marker: 'value' },
        overrides: {},
        deps,
        storageRoot: ctx.storageRoot,
        runId: 'run-failed',
      }),
      (err: unknown) => {
        assert.ok(err instanceof PipelineTemplateError);
        assert.equal(err.code, 'X_SELECTOR_MISSING');
        assert.equal(err.context.runDir, ctx.runDir);
        return true;
      },
    );
    assert.equal(deps.finalizeCalls.length, 1);
    assert.deepEqual(deps.finalizeCalls[0], { status: 'failed', errorCode: 'X_SELECTOR_MISSING' });

    const manifest = await readManifest(ctx.runDir);
    assert.equal(manifest.status, 'failed');
    assert.equal(manifest.error?.code, 'X_SELECTOR_MISSING');
    assert.deepEqual(
      manifest.stages.map((stage) => [stage.id, stage.status]),
      [
        ['one', 'succeeded'],
        ['two', 'failed'],
        ['three', 'not-run'],
      ],
    );
  });

  it('runs finalize on failure without masking the stage error', async () => {
    const deps: TestDeps = { failAt: 'three', finalizeError: true, finalizeCalls: [] };
    const ctx = await setup('run-finalize-failed');
    await assert.rejects(
      runPipeline({
        definition: definition(deps),
        configPath: ctx.configPath,
        config: { marker: 'value' },
        overrides: {},
        deps,
        storageRoot: ctx.storageRoot,
        runId: 'run-finalize-failed',
      }),
      (err: unknown) => {
        assert.ok(err instanceof PipelineTemplateError);
        assert.equal(err.code, 'X_DRAFT_NOT_SAVED');
        return true;
      },
    );
    assert.equal(deps.finalizeCalls.length, 1);
  });

  it('fails the run when finalize throws on an otherwise successful run', async () => {
    const deps: TestDeps = { finalizeError: true, finalizeCalls: [] };
    const ctx = await setup('run-finalize-error');
    await assert.rejects(
      runPipeline({
        definition: definition(deps),
        configPath: ctx.configPath,
        config: { marker: 'value' },
        overrides: {},
        deps,
        storageRoot: ctx.storageRoot,
        runId: 'run-finalize-error',
      }),
      (err: unknown) => {
        assert.ok(err instanceof PipelineTemplateError);
        assert.equal(err.code, 'UNEXPECTED_ERROR');
        assert.match(err.message, /finalize exploded/);
        return true;
      },
    );
    const manifest = await readManifest(ctx.runDir);
    assert.equal(manifest.status, 'failed');
  });
});
