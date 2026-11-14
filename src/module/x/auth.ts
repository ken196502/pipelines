import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { captureEvidence } from '../../lib/browser/evidence.js';
import type { BrowserSession } from '../../lib/browser/firefox.js';
import { navigateWithRetry } from '../../lib/browser/navigation.js';
import { XError } from '../../lib/errors.js';
import type { JsonlLogger } from '../../lib/log/jsonl-logger.js';
import { SELECTORS } from './selectors.js';
import type { XEndpoints } from './search.js';

export interface AuthOptions {
  mode: 'profile' | 'cookies';
  cookiesFile?: string;
  expectedHandle?: string;
  logger: JsonlLogger;
  evidenceDir: string;
  stage: string;
  endpoints: XEndpoints;
}

const cookieSchema = z
  .array(
    z
      .object({
        name: z.string().min(1),
        value: z.string(),
        domain: z.string().min(1),
        path: z.string().min(1),
        secure: z.boolean(),
        httpOnly: z.boolean().optional(),
      })
      .strict(),
  )
  .min(1);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function injectCookies(session: BrowserSession, file: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    throw new XError('X_AUTH_COOKIES_INVALID', `Cannot read cookies file ${file}.`, { cookiesFile: file }, { cause: err });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new XError('X_AUTH_COOKIES_INVALID', `Cookies file ${file} is not valid JSON.`, { cookiesFile: file }, {
      cause: err,
    });
  }

  const result = cookieSchema.safeParse(parsed);
  if (!result.success) {
    throw new XError('X_AUTH_COOKIES_INVALID', `Cookies file ${file} does not match the expected cookie array.`, {
      cookiesFile: file,
      issues: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }

  const names = new Set(result.data.map((cookie) => cookie.name));
  const missing = ['auth_token', 'ct0'].filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new XError('X_AUTH_COOKIES_INVALID', `Cookies file ${file} is missing ${missing.join(', ')}.`, {
      cookiesFile: file,
      missing,
    });
  }

  try {
    await session.browser.setCookies(
      result.data.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        ...(cookie.httpOnly === undefined ? {} : { httpOnly: cookie.httpOnly }),
      })),
    );
  } catch (err) {
    throw new XError(
      'X_AUTH_COOKIES_INVALID',
      `The browser rejected one or more cookies from ${file}; nothing was retried or skipped.`,
      { cookiesFile: file },
      { cause: err },
    );
  }
}

async function readHandle(session: BrowserSession): Promise<string | undefined> {
  const text = await session.browser.execute((selector: string) => {
    const marker = document.querySelector(selector);
    return marker ? marker.textContent ?? '' : '';
  }, SELECTORS.loggedInMarker.css);
  const match = /@([A-Za-z0-9_]{1,15})/.exec(String(text));
  return match?.[1];
}

/**
 * Verifies that the session is logged in. Any login wall, challenge page or
 * wrong account is an error; nothing is retried and no fallback account exists.
 */
export async function ensureLoggedIn(session: BrowserSession, opts: AuthOptions): Promise<{ handle: string }> {
  if (opts.mode === 'cookies') {
    if (!opts.cookiesFile) {
      throw new XError('X_AUTH_COOKIES_INVALID', 'auth.mode is "cookies" but auth.cookiesFile is not set.', {});
    }
    await injectCookies(session, opts.cookiesFile);
  }

  const url = `${opts.endpoints.baseUrl.replace(/\/+$/, '')}/home`;
  await navigateWithRetry(session.browser, { url, logger: opts.logger, stage: opts.stage });

  const title = await session.browser.getTitle();
  if (title.includes('Just a moment')) {
    const evidence = await captureEvidence(session, opts.evidenceDir, 'auth-challenge', opts.logger);
    throw new XError(
      'X_CHALLENGE',
      'x.com showed a Cloudflare challenge. The pipeline does not bypass challenges; complete it manually and retry.',
      { url: await session.browser.getUrl(), evidence },
    );
  }

  const currentUrl = await session.browser.getUrl();
  if (currentUrl.includes('/i/flow/login') || /\/login(\?|$)/.test(currentUrl)) {
    const evidence = await captureEvidence(session, opts.evidenceDir, 'auth-required', opts.logger);
    throw new XError(
      'X_AUTH_REQUIRED',
      `x.com redirected to ${new URL(currentUrl).pathname}. Run "npm run xblog:login" with auth.mode=profile, or provide a valid cookies file.`,
      { url: currentUrl, mode: opts.mode, evidence },
    );
  }

  const markers = await session.browser.$$(SELECTORS.loggedInMarker.css);
  const marker = markers[0];
  try {
    if (!marker) throw new Error('no account switcher');
    await marker.waitForDisplayed({ timeout: 30_000 });
  } catch (err) {
    const evidence = await captureEvidence(session, opts.evidenceDir, 'auth-marker-missing', opts.logger);
    throw new XError(
      'X_AUTH_REQUIRED',
      'The account switcher never appeared on /home, so the session is not logged in.',
      { url: currentUrl, selector: 'loggedInMarker', evidence },
    );
  }

  const handle = await readHandle(session);
  if (!handle) {
    const evidence = await captureEvidence(session, opts.evidenceDir, 'auth-handle-unreadable', opts.logger);
    throw new XError('X_AUTH_REQUIRED', 'Logged in, but the account handle could not be read.', { evidence });
  }

  if (opts.expectedHandle && handle.toLowerCase() !== opts.expectedHandle.replace(/^@/, '').toLowerCase()) {
    throw new XError(
      'X_AUTH_WRONG_ACCOUNT',
      `Logged in as @${handle}, expected @${opts.expectedHandle.replace(/^@/, '')}.`,
      { handle, expectedHandle: opts.expectedHandle },
    );
  }

  opts.logger.info('x:auth-ok', { stage: opts.stage, data: { handle, mode: opts.mode } });
  return { handle };
}

/** Used by the login command: waits for a manual login in a headed browser. */
export async function waitForManualLogin(
  session: BrowserSession,
  opts: { logger: JsonlLogger; timeoutMs: number },
): Promise<{ handle: string }> {
  const markers = await session.browser.$$(SELECTORS.loggedInMarker.css);
  const marker = markers[0];
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    if (marker && (await marker.isDisplayed())) {
      const handle = await readHandle(session);
      if (!handle) {
        throw new XError('X_AUTH_REQUIRED', 'Logged in, but the account handle could not be read.', {});
      }
      opts.logger.info('x:auth-ok', { data: { handle, mode: 'manual' } });
      return { handle };
    }
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    process.stderr.write(`\rWaiting for login... ${remaining}s remaining `);
    await sleep(1_000);
  }
  throw new XError('X_AUTH_REQUIRED', `No login detected within ${opts.timeoutMs} ms.`, { timeoutMs: opts.timeoutMs });
}
