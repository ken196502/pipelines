import assert from 'node:assert/strict';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { launchFirefox, type BrowserSession } from '../src/lib/browser/firefox.js';
import { XError } from '../src/lib/errors.js';
import { JsonlLogger } from '../src/lib/log/jsonl-logger.js';
import { ensureLoggedIn } from '../src/module/x/auth.js';
import {
  attachCoverImage,
  openArticleDraft,
  readLeadingText,
  setBody,
  setTitle,
  verifyDraftListed,
  waitForSaved,
} from '../src/module/x/draft-editor.js';
import { safeClick } from '../src/module/x/safe-click.js';
import { buildSearchUrl, searchKeyword, type XEndpoints } from '../src/module/x/search.js';
import { cleanupTmpDirs, makeTmpDir } from './helpers/tmp.js';

const ENABLED = process.env.XBLOG_BROWSER_SMOKE === '1';
const FIREFOX = '/usr/bin/firefox-esr';
const GECKODRIVER = join(process.cwd(), '.cache', 'geckodriver', 'geckodriver');
const FIXTURES = join(process.cwd(), 'tests', 'helpers', 'fixtures');

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

describe('browser smoke (local fixtures only)', { skip: ENABLED ? false : 'set XBLOG_BROWSER_SMOKE=1 to run' }, () => {
  let server: Server;
  let session: BrowserSession;
  let logger: JsonlLogger;
  let tmpDir: string;
  let profileDir: string;
  let evidenceDir: string;
  let endpoints: XEndpoints;
  let mode: 'ok' | 'login' | 'upsell' = 'ok';

  before(async () => {
    tmpDir = await makeTmpDir('browser-smoke');
    profileDir = join(tmpDir, 'profile');
    evidenceDir = join(tmpDir, 'evidence');
    logger = new JsonlLogger({ file: join(tmpDir, 'events.jsonl'), runId: 'smoke', pipelineId: 'xblog' });

    const files: Record<string, string> = {
      '/search': 'search.html',
      '/login': 'login-wall.html',
      '/home': 'home.html',
      '/compose/articles': 'editor.html',
    };

    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/home' && mode === 'login') {
        res.writeHead(302, { location: '/login' });
        res.end();
        return;
      }
      const file =
        url.pathname === '/compose/articles' && mode === 'upsell' ? 'upsell.html' : files[url.pathname];
      if (!file) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      const html = await readFile(join(FIXTURES, file), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    endpoints = { baseUrl: `http://127.0.0.1:${address.port}` };

    session = await launchFirefox({
      firefoxBinary: FIREFOX,
      geckodriverBinary: GECKODRIVER,
      profileDir,
      headless: true,
      windowSize: { width: 1280, height: 900 },
      logDir: join(tmpDir, 'webdriver'),
      pageLoadTimeoutMs: 30_000,
      logger,
    });
  });

  after(async () => {
    if (session) {
      const { firefoxPid, geckodriverPid } = session;
      await session.close();
      if (firefoxPid !== null) assert.equal(pidAlive(firefoxPid), false, 'Firefox must exit after close');
      if (geckodriverPid !== null) assert.equal(pidAlive(geckodriverPid), false, 'geckodriver must exit after close');
      await rm(profileDir, { recursive: true, force: true });
      await assert.rejects(access(profileDir), (err: unknown) => {
        assert.equal((err as NodeJS.ErrnoException).code, 'ENOENT');
        return true;
      });
    }
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
    logger?.close();
    await cleanupTmpDirs();
  });

  it('parses search results and drops reposts and promoted posts', async () => {
    const url = buildSearchUrl('agent orchestration', { feed: 'top', baseUrl: endpoints.baseUrl });
    assert.ok(url.startsWith(`${endpoints.baseUrl}/search?`));

    const result = await searchKeyword(session, 'agent orchestration', {
      feed: 'top',
      maxTweets: 10,
      maxScrolls: 2,
      logger,
      stage: 'x-search',
      endpoints,
      evidenceDir,
    });
    assert.deepEqual(
      result.tweets.map((tweet) => tweet.id),
      ['111', '444'],
    );
    assert.equal(result.dropped.retweet, 1);
    assert.equal(result.dropped.promoted, 1);
    assert.ok(result.tweets[1]?.text.includes('Add Adobe'));
  });

  it('fails with X_AUTH_REQUIRED on the login wall', async () => {
    mode = 'login';
    try {
      await assert.rejects(
        ensureLoggedIn(session, {
          mode: 'profile',
          logger,
          evidenceDir,
          stage: 'x-auth',
          endpoints,
        }),
        (err: unknown) => {
          assert.ok(err instanceof XError);
          assert.equal(err.code, 'X_AUTH_REQUIRED');
          return true;
        },
      );
    } finally {
      mode = 'ok';
    }
  });

  it('fails with X_ARTICLES_UNAVAILABLE on the upsell wall', async () => {
    mode = 'upsell';
    try {
      await assert.rejects(
        openArticleDraft(session, { endpoints, logger, evidenceDir, stage: 'draft-compose' }),
        (err: unknown) => {
          assert.ok(err instanceof XError);
          assert.equal(err.code, 'X_ARTICLES_UNAVAILABLE');
          return true;
        },
      );
    } finally {
      mode = 'ok';
    }
  });

  it('composes a draft, uploads a cover and reads the leading text', async () => {
    const draftOptions = { endpoints, logger, evidenceDir, stage: 'draft-compose' };
    const { editUrl } = await openArticleDraft(session, draftOptions);
    assert.ok(editUrl.startsWith(endpoints.baseUrl));

    await setTitle(session, 'A Test Draft Title');
    await setBody(
      session,
      '## A heading\n\nA paragraph about agent orchestration.\n\n- first point\n- second point\n\n> A quote.',
    );

    const leading = await readLeadingText(session, 200);
    assert.ok(leading.startsWith('A Test Draft Title'));
    assert.ok(leading.includes('A paragraph about agent orchestration.'));

    const imagePath = join(tmpDir, 'cover.png');
    await writeFile(imagePath, Buffer.alloc(2048, 0x89));
    await attachCoverImage(session, imagePath, { timeoutMs: 20_000 });

    await waitForSaved(session, 15_000);
    const listed = await verifyDraftListed(session, 'A Test Draft Title', {
      endpoints,
      logger,
      evidenceDir,
      stage: 'draft-save',
    });
    assert.ok(listed.startsWith(`${endpoints.baseUrl}/compose/articles`));
  });

  it('refuses to click the fixture Publish button', async () => {
    const publish = await session.browser.$('[data-testid="publishButton"]');
    await assert.rejects(safeClick(publish, 'save draft'), (err: unknown) => {
      assert.ok(err instanceof XError);
      assert.equal(err.code, 'X_PUBLISH_FORBIDDEN');
      return true;
    });
    const published = await session.browser.execute(() => (window as unknown as { __published?: boolean }).__published);
    assert.notEqual(published, true);
  });
});
