import type { BrowserSession } from '../../lib/browser/firefox.js';
import { navigateWithRetry } from '../../lib/browser/navigation.js';
import { XError } from '../../lib/errors.js';
import type { JsonlLogger } from '../../lib/log/jsonl-logger.js';
import { safeClick } from './safe-click.js';
import { SELECTORS, type SelectorName } from './selectors.js';
import type { XEndpoints } from './search.js';

export interface DraftOptions {
  endpoints: XEndpoints;
  logger: JsonlLogger;
  evidenceDir: string;
  stage: string;
}

const UPSELL_PATTERNS = ['Upgrade to', 'Subscribe to', 'Get access to', 'Unlock', 'Premium is required'];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findSelector(
  session: BrowserSession,
  name: SelectorName,
  timeoutMs = 15_000,
): Promise<WebdriverIO.Element> {
  const elements = await session.browser.$$(SELECTORS[name].css);
  const element = elements[0];
  try {
    if (!element) throw new Error('no element');
    await element.waitForDisplayed({ timeout: timeoutMs });
  } catch (err) {
    throw new XError(
      'X_SELECTOR_MISSING',
      `Selector "${name}" (${SELECTORS[name].css}) was not found within ${timeoutMs} ms.`,
      { selector: name, css: SELECTORS[name].css, url: await session.browser.getUrl() },
      { cause: err },
    );
  }
  return element;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inlineMarkdown(text: string): string {
  return escapeHtml(text)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/** Minimal markdown to HTML: headings, paragraphs, quotes, lists and links. */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let paragraph: string[] = [];

  const closeList = (): void => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      out.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim() === '') {
      flushParagraph();
      closeList();
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      closeList();
      const level = (heading[1] ?? '#').length;
      out.push(`<h${level}>${inlineMarkdown(heading[2] ?? '')}</h${level}>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushParagraph();
      closeList();
      out.push(`<blockquote>${inlineMarkdown(line.replace(/^>\s?/, ''))}</blockquote>`);
      continue;
    }
    const unordered = /^[-*]\s+(.*)$/.exec(line);
    if (unordered) {
      flushParagraph();
      if (list !== 'ul') {
        closeList();
        out.push('<ul>');
        list = 'ul';
      }
      out.push(`<li>${inlineMarkdown(unordered[1] ?? '')}</li>`);
      continue;
    }
    const ordered = /^\d+\.\s+(.*)$/.exec(line);
    if (ordered) {
      flushParagraph();
      if (list !== 'ol') {
        closeList();
        out.push('<ol>');
        list = 'ol';
      }
      out.push(`<li>${inlineMarkdown(ordered[1] ?? '')}</li>`);
      continue;
    }
    closeList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  closeList();
  return out.join('\n');
}

function htmlText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Opens the X Articles editor. An upsell or upgrade wall means the account is
 * not eligible, which is an explicit error rather than a different draft flow.
 */
export async function openArticleDraft(session: BrowserSession, opts: DraftOptions): Promise<{ editUrl: string }> {
  const url = `${opts.endpoints.baseUrl.replace(/\/+$/, '')}/compose/articles`;
  await navigateWithRetry(session.browser, { url, logger: opts.logger, stage: opts.stage });

  const bodyText = String(
    await session.browser.execute(() => (document.body ? document.body.innerText : '')),
  );
  const createButtons = await session.browser.$$(SELECTORS.articlesCreate.css);
  const create = createButtons[0];
  const visible = create ? await create.isDisplayed() : false;
  if (!create || !visible) {
    const upsell = UPSELL_PATTERNS.find((pattern) => bodyText.includes(pattern));
    throw new XError(
      'X_ARTICLES_UNAVAILABLE',
      upsell
        ? `The Articles editor shows an upsell wall ("${upsell}"); this account is not eligible for Articles.`
        : 'The Articles editor did not render its create button. The account may not be eligible for Articles.',
      { url: await session.browser.getUrl(), selector: 'articlesCreate', evidenceDir: opts.evidenceDir },
    );
  }

  await safeClick(create, 'create article');
  await sleep(500);
  const editUrl = await session.browser.getUrl();
  return { editUrl };
}

export async function setTitle(session: BrowserSession, title: string): Promise<void> {
  const field = await findSelector(session, 'articleTitle');
  await field.setValue(title);
  const actual = await field.getValue();
  if (actual !== title) {
    throw new XError('X_DRAFT_NOT_SAVED', 'The article title did not match after typing.', {
      expected: title,
      actual,
      selector: 'articleTitle',
    });
  }
}

export async function setBody(session: BrowserSession, markdown: string): Promise<void> {
  const composer = await findSelector(session, 'articleComposer');
  const html = markdownToHtml(markdown);
  const inserted = await session.browser.execute(
    (payload: { selector: string; html: string }) => {
      const element = document.querySelector(payload.selector);
      if (!(element instanceof HTMLElement)) return false;
      element.focus();
      element.innerHTML = payload.html;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
      return true;
    },
    { selector: SELECTORS.articleComposer.css, html },
  );
  if (inserted !== true) {
    throw new XError('X_SELECTOR_MISSING', 'The composer disappeared while inserting the article body.', {
      selector: 'articleComposer',
    });
  }

  const expected = htmlText(html).length;
  const actualText = await composer.getText();
  const actual = actualText.replace(/\s+/g, ' ').trim().length;
  if (expected > 0 && actual < expected * 0.9) {
    throw new XError('X_DRAFT_NOT_SAVED', 'The article body was not fully inserted into the composer.', {
      expectedChars: expected,
      actualChars: actual,
      selector: 'articleComposer',
    });
  }
}

export async function attachCoverImage(
  session: BrowserSession,
  filePath: string,
  opts?: { timeoutMs?: number },
): Promise<void> {
  const inputs = await session.browser.$$(SELECTORS.coverFileInput.css);
  let target: WebdriverIO.Element | undefined;
  for (const input of inputs) {
    const accept = (await input.getAttribute('accept')) ?? '';
    if (!/video/i.test(accept)) {
      target = input;
      break;
    }
  }
  if (!target) {
    throw new XError('X_SELECTOR_MISSING', 'No cover image file input was found (only video inputs are present).', {
      selector: 'coverFileInput',
    });
  }

  await target.addValue(filePath);

  const applyButtons = await session.browser.$$('//button[normalize-space(.)="Apply"]');
  const apply = applyButtons[0];
  if (apply && (await apply.isExisting())) {
    await safeClick(apply, 'apply cover image');
  }

  const timeoutMs = opts?.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hasImage = await session.browser.execute(
      () =>
        Array.from(document.querySelectorAll('img[src]')).some((image) => {
          const src = image.getAttribute('src') ?? '';
          return src.startsWith('blob:') || src.startsWith('data:');
        }),
    );
    if (hasImage === true) return;
    await sleep(500);
  }
  throw new XError('X_COVER_NOT_ATTACHED', `No cover preview appeared within ${timeoutMs} ms after uploading.`, {
    filePath,
    timeoutMs,
    selector: 'coverImage',
  });
}

/** Returns the title plus the first composer block, as rendered. */
export async function readLeadingText(session: BrowserSession, chars = 200): Promise<string> {
  const titleField = await findSelector(session, 'articleTitle');
  const composer = await findSelector(session, 'articleComposer');
  const title = await titleField.getValue();
  const body = await composer.getText();
  return `${title}\n${body}`.trim().slice(0, chars);
}

export async function waitForSaved(session: BrowserSession, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = String(await session.browser.execute(() => (document.body ? document.body.innerText : '')));
    if (/\bSaved\b/.test(text)) return;
    await sleep(500);
  }
  throw new XError('X_DRAFT_NOT_SAVED', `The editor did not report "Saved" within ${timeoutMs} ms.`, { timeoutMs });
}

/** Confirms the draft appears in the Articles drafts list and returns its edit URL. */
export async function verifyDraftListed(session: BrowserSession, title: string, opts: DraftOptions): Promise<string> {
  const url = `${opts.endpoints.baseUrl.replace(/\/+$/, '')}/compose/articles`;
  await navigateWithRetry(session.browser, { url, logger: opts.logger, stage: opts.stage });

  const deadline = Date.now() + 15_000;
  let href: string | null = null;
  while (Date.now() < deadline && href === null) {
    href = (await session.browser.execute((wanted: string) => {
      const links = Array.from(document.querySelectorAll('a'));
      const match = links.find((link) => (link.textContent ?? '').trim().includes(wanted));
      return match ? match.getAttribute('href') : null;
    }, title)) as string | null;
    if (href === null) await sleep(500);
  }

  if (href === null) {
    throw new XError('X_DRAFT_NOT_SAVED', `The draft "${title}" is not listed under /compose/articles.`, {
      title,
      url,
      selector: 'draftList',
    });
  }
  return href.startsWith('http') ? href : `${opts.endpoints.baseUrl.replace(/\/+$/, '')}${href}`;
}
