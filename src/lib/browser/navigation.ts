import { BrowserError } from '../errors.js';
import type { JsonlLogger } from '../log/jsonl-logger.js';

export interface NavigateOptions {
  url: string;
  logger: JsonlLogger;
  stage: string;
  maxAttempts?: number;
  retryDelayMs?: number;
}

function isTimeout(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'TimeoutError' || /timeout|timed out/i.test(err.message);
}

async function sessionAlive(browser: WebdriverIO.Browser): Promise<boolean> {
  try {
    await browser.execute(() => document.readyState);
    return true;
  } catch (err) {
    throw new BrowserError('BROWSER_SESSION_LOST', 'The browser session is no longer reachable.', {}, { cause: err });
  }
}

async function isBlank(browser: WebdriverIO.Browser): Promise<boolean> {
  const text = await browser.execute(() => (document.body ? document.body.innerText : ''));
  return String(text).trim() === '';
}

/**
 * Navigates with retries only for navigation timeouts and blank-page landings.
 * A dead session is fatal and is never retried.
 */
export async function navigateWithRetry(browser: WebdriverIO.Browser, opts: NavigateOptions): Promise<void> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const retryDelayMs = opts.retryDelayMs ?? 1_000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    opts.logger.debug('browser:navigate', { stage: opts.stage, data: { url: opts.url, attempt } });
    try {
      await browser.url(opts.url);
    } catch (err) {
      if (!isTimeout(err)) {
        throw new BrowserError(
          'BROWSER_NAVIGATION_FAILED',
          `Navigation to ${opts.url} failed.`,
          { url: opts.url, attempt, stage: opts.stage },
          { cause: err },
        );
      }
      if (attempt === maxAttempts) {
        throw new BrowserError(
          'BROWSER_NAVIGATION_TIMEOUT',
          `Navigation to ${opts.url} timed out after ${maxAttempts} attempt(s).`,
          { url: opts.url, attempt, stage: opts.stage },
          { cause: err },
        );
      }
      await sessionAlive(browser);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      continue;
    }

    await sessionAlive(browser);
    if (!(await isBlank(browser))) return;
    if (attempt === maxAttempts) {
      throw new BrowserError(
        'BROWSER_BLANK_PAGE',
        `Navigation to ${opts.url} landed on a blank page after ${maxAttempts} attempt(s).`,
        { url: opts.url, attempt, stage: opts.stage },
      );
    }
    opts.logger.warn('browser:navigate-blank', { stage: opts.stage, data: { url: opts.url, attempt } });
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
}
