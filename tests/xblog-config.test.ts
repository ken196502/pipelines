import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { ConfigError } from '../src/lib/errors.js';
import { readJsonConfig } from '../src/lib/config/load.js';
import { applyOverrides, resolveConfigPaths, xblogConfigSchema } from '../src/pipeline/xblog/config.js';
import { cleanupTmpDirs, makeTmpDir } from './helpers/tmp.js';

after(async () => {
  await cleanupTmpDirs();
});

async function loadCommittedConfig() {
  return readJsonConfig(join(process.cwd(), 'config', 'xblog.json'), xblogConfigSchema);
}

describe('xblog config', () => {
  it('loads the committed config with the documented defaults', async () => {
    const config = await loadCommittedConfig();
    assert.equal(config.language, 'en');
    assert.deepEqual(config.keywords, ['Agent system', 'Agent orchestration']);
    assert.equal(config.storage.root, '../data');
    assert.equal(config.search.feed, 'top');
    assert.equal(config.search.useLangOperator, false);
    assert.equal(config.relevance.minScore, 6);
    assert.equal(config.auth.mode, 'profile');
    assert.deepEqual(config.premium.markers, ['[Premium]']);
  });

  it('applies and records CLI overrides, then revalidates', async () => {
    const config = await loadCommittedConfig();
    const { config: applied, recorded } = applyOverrides(config, {
      language: 'zh',
      keywords: ' MCP , agent memory ',
      headed: true,
    });
    assert.equal(applied.language, 'zh');
    assert.deepEqual(applied.keywords, ['MCP', 'agent memory']);
    assert.equal(applied.browser.headless, false);
    assert.deepEqual(recorded, { language: 'zh', keywords: ['MCP', 'agent memory'], headed: true });
  });

  it('rejects an unsupported language override', async () => {
    const config = await loadCommittedConfig();
    assert.throws(() => applyOverrides(config, { language: 'fr' }), (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.code, 'CONFIG_INVALID');
      return true;
    });
  });

  it('rejects duplicate and empty keywords', async () => {
    const config = await loadCommittedConfig();
    assert.throws(() => applyOverrides(config, { keywords: 'agents,AGENTS' }), /duplicate keyword/);
    assert.throws(() => applyOverrides(config, { keywords: 'agents,,memory' }), /keyword must not be empty/);
  });

  it('rejects an empty premium marker list', async () => {
    const config = await loadCommittedConfig();
    const withoutMarkers = structuredClone(config) as Record<string, unknown>;
    (withoutMarkers.premium as Record<string, unknown>).markers = [];
    assert.throws(() => xblogConfigSchema.parse(withoutMarkers), /markers/);
  });

  it('enforces the auth mode/field coupling', async () => {
    const config = await loadCommittedConfig();
    const cookiesWithoutFile = structuredClone(config) as Record<string, unknown>;
    (cookiesWithoutFile.auth as Record<string, unknown>).mode = 'cookies';
    assert.throws(() => xblogConfigSchema.parse(cookiesWithoutFile), /cookiesFile/);

    const profileWithoutDir = structuredClone(config) as Record<string, unknown>;
    (profileWithoutDir.auth as Record<string, unknown>).profileDir = null;
    assert.throws(() => xblogConfigSchema.parse(profileWithoutDir), /profileDir/);
  });

  it('rejects an unknown key', async () => {
    const config = await loadCommittedConfig();
    const withTypo = { ...structuredClone(config), keyword: ['typo'] } as Record<string, unknown>;
    assert.throws(() => xblogConfigSchema.parse(withTypo), /Unrecognized key/);
  });

  it('resolves relative paths against the config directory', async () => {
    const config = await loadCommittedConfig();
    const dir = await makeTmpDir('xblog-config');
    const resolved = resolveConfigPaths(config, dir);
    assert.equal(resolved.storage.root, resolve(dir, '..', 'data'));
    assert.equal(resolved.llm.profilesFile, join(dir, 'llm.json'));
    assert.equal(resolved.browser.geckodriverBinary, resolve(dir, '..', '.cache', 'geckodriver', 'geckodriver'));
    assert.equal(resolved.auth.profileDir, resolve(dir, '..', 'data', 'browser-profiles', 'x'));
    assert.equal(resolved.auth.cookiesFile, null);
  });
});
