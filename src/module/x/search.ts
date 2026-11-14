import { captureEvidence } from '../../lib/browser/evidence.js';
import type { BrowserSession } from '../../lib/browser/firefox.js';
import { navigateWithRetry } from '../../lib/browser/navigation.js';
import { XError } from '../../lib/errors.js';
import type { JsonlLogger } from '../../lib/log/jsonl-logger.js';
import { SELECTORS } from './selectors.js';

export const X_BASE_URL = 'https://x.com';

export interface XEndpoints {
  baseUrl: string;
}

export interface RawTweetRecord {
  href: string | null;
  authorText: string | null;
  authorHref: string | null;
  time: string | null;
  text: string | null;
  socialContext: string | null;
  placementTracking: string | null;
  adLabel: string | null;
}

export interface Tweet {
  id: string;
  url: string;
  author: string;
  createdAt: string;
  text: string;
}

export interface DroppedCounts {
  promoted: number;
  retweet: number;
  malformed: number;
}

export interface ParseResult {
  tweets: Tweet[];
  dropped: DroppedCounts;
}

export interface SearchOptions {
  feed: 'top' | 'live';
  maxTweets: number;
  maxScrolls: number;
  logger: JsonlLogger;
  stage: string;
  endpoints: XEndpoints;
  evidenceDir: string;
}

const BLOCKED_PATTERNS = ['Something went wrong', 'Rate limit exceeded', 'You are unable to'];
const NO_RESULTS_PATTERNS = ['No results for', 'No results found', 'Nothing to see here'];

export function buildSearchUrl(
  keyword: string,
  opts: { feed: 'top' | 'live'; languageOperator?: string; baseUrl: string },
): string {
  const query = opts.languageOperator ? `${keyword} lang:${opts.languageOperator}` : keyword;
  const params = new URLSearchParams({ q: query, src: 'typed_query', f: opts.feed });
  return `${opts.baseUrl.replace(/\/+$/, '')}/search?${params.toString()}`;
}

function authorOf(record: RawTweetRecord): string | undefined {
  if (record.authorHref) {
    const match = /^\/([A-Za-z0-9_]{1,15})\/?$/.exec(record.authorHref);
    if (match?.[1]) return match[1];
  }
  if (record.authorText) {
    const match = /@([A-Za-z0-9_]{1,15})/.exec(record.authorText);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function isPromoted(record: RawTweetRecord): boolean {
  if (record.placementTracking !== null && record.placementTracking !== '') return true;
  return record.adLabel !== null && /^ad$/i.test(record.adLabel.trim());
}

function isRepost(record: RawTweetRecord): boolean {
  return record.socialContext !== null && /\b(reposted|retweeted|repost)\b/i.test(record.socialContext);
}

/**
 * Pure parser used by the search stage and by fixture tests. Promoted posts are
 * detected through their dedicated tracking nodes, never by matching "Ad" as a
 * substring (which would also match "Add" and "Adobe").
 */
export function parseTweetRecords(raw: RawTweetRecord[]): ParseResult {
  const dropped: DroppedCounts = { promoted: 0, retweet: 0, malformed: 0 };
  const tweets: Tweet[] = [];

  for (const record of raw) {
    if (isPromoted(record)) {
      dropped.promoted += 1;
      continue;
    }
    if (isRepost(record)) {
      dropped.retweet += 1;
      continue;
    }
    const id = record.href ? /\/status\/(\d+)/.exec(record.href)?.[1] : undefined;
    const author = authorOf(record);
    const text = record.text?.trim();
    const createdAt = record.time ?? undefined;
    if (!id || !author || !text || !createdAt || Number.isNaN(Date.parse(createdAt))) {
      dropped.malformed += 1;
      continue;
    }
    tweets.push({
      id,
      url: `${X_BASE_URL}/${author}/status/${id}`,
      author,
      createdAt: new Date(createdAt).toISOString(),
      text,
    });
  }

  return { tweets, dropped };
}

const COLLECT_SCRIPT = (selectors: Record<string, string>): RawTweetRecord[] => {
  const nodes = Array.from(document.querySelectorAll(selectors.tweet ?? ''));
  return nodes.map((node) => {
    const link = node.querySelector(selectors.tweetStatusLink ?? '');
    const userName = node.querySelector(selectors.tweetUser ?? '');
    const userLink = userName ? userName.querySelector('a[href^="/"]') : null;
    const time = node.querySelector(selectors.tweetTime ?? '');
    const text = node.querySelector(selectors.tweetText ?? '');
    const social = node.querySelector(selectors.socialContext ?? '');
    const promoted = node.querySelector(selectors.promotedTracking ?? '');
    const adNode = Array.from(node.querySelectorAll('span, div')).find(
      (candidate) => candidate.children.length === 0 && /^ad$/i.test((candidate.textContent ?? '').trim()),
    );
    return {
      href: link ? link.getAttribute('href') : null,
      authorText: userName ? userName.textContent : null,
      authorHref: userLink ? userLink.getAttribute('href') : null,
      time: time ? time.getAttribute('datetime') : null,
      text: text ? text.textContent : null,
      socialContext: social ? social.textContent : null,
      placementTracking: promoted ? promoted.textContent || 'present' : null,
      adLabel: adNode ? adNode.textContent : null,
    };
  });
};

function pageText(session: BrowserSession): Promise<string> {
  return session.browser
    .execute(() => (document.body ? document.body.innerText : ''))
    .then((value) => String(value));
}

async function assertNotBlocked(session: BrowserSession, opts: SearchOptions, keyword: string, text: string): Promise<void> {
  const blocked = BLOCKED_PATTERNS.find((pattern) => text.includes(pattern));
  if (!blocked) return;
  const evidence = await captureEvidence(session, opts.evidenceDir, `search-blocked-${keyword}`, opts.logger);
  throw new XError(
    'X_SEARCH_BLOCKED',
    `Search for "${keyword}" hit an x.com block page ("${blocked}"). No partial results are returned.`,
    { keyword, evidence, evidenceDir: opts.evidenceDir },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Searches one keyword, scrolls up to maxScrolls times and returns deduplicated
 * posts. A block page fails the whole search, even after earlier results.
 */
export async function searchKeyword(
  session: BrowserSession,
  keyword: string,
  opts: SearchOptions,
): Promise<ParseResult> {
  const url = buildSearchUrl(keyword, {
    feed: opts.feed,
    baseUrl: opts.endpoints.baseUrl,
  });
  await navigateWithRetry(session.browser, { url, logger: opts.logger, stage: opts.stage });

  const initialText = await pageText(session);
  await assertNotBlocked(session, opts, keyword, initialText);

  const tweetNodes = await session.browser.$$(SELECTORS.tweet.css);
  const firstTweet = tweetNodes[0];
  try {
    if (!firstTweet) throw new Error('no post nodes');
    await firstTweet.waitForDisplayed({ timeout: 15_000 });
  } catch (err) {
    const text = await pageText(session);
    await assertNotBlocked(session, opts, keyword, text);
    if (NO_RESULTS_PATTERNS.some((pattern) => text.includes(pattern))) {
      opts.logger.info('x:search-empty', { stage: opts.stage, data: { keyword } });
      return { tweets: [], dropped: { promoted: 0, retweet: 0, malformed: 0 } };
    }
    const evidence = await captureEvidence(session, opts.evidenceDir, `search-missing-${keyword}`, opts.logger);
    throw new XError(
      'X_SELECTOR_MISSING',
      `No post nodes appeared for "${keyword}" and the page is neither empty nor blocked.`,
      { keyword, selector: 'tweet', evidence, url, ...(err instanceof Error ? { cause: err.message } : {}) },
    );
  }

  const selectors: Record<string, string> = {
    tweet: SELECTORS.tweet.css,
    tweetStatusLink: SELECTORS.tweetStatusLink.css,
    tweetUser: SELECTORS.tweetUser.css,
    tweetTime: SELECTORS.tweetTime.css,
    tweetText: SELECTORS.tweetText.css,
    socialContext: SELECTORS.socialContext.css,
    promotedTracking: SELECTORS.promotedTracking.css,
  };

  const collected: Tweet[] = [];
  const seenIds = new Set<string>();
  const seenHrefs = new Set<string>();
  const dropped: DroppedCounts = { promoted: 0, retweet: 0, malformed: 0 };
  let rawCount = 0;
  let idleRounds = 0;

  for (let round = 0; round <= opts.maxScrolls; round += 1) {
    const raw = (await session.browser.execute(COLLECT_SCRIPT, selectors)) as RawTweetRecord[];
    rawCount += raw.length;
    const fresh = raw.filter((record) => {
      const key = record.href ?? `${record.authorText ?? ''}|${record.time ?? ''}|${record.text ?? ''}`;
      if (seenHrefs.has(key)) return false;
      seenHrefs.add(key);
      return true;
    });
    const parsed = parseTweetRecords(fresh);
    dropped.promoted += parsed.dropped.promoted;
    dropped.retweet += parsed.dropped.retweet;
    dropped.malformed += parsed.dropped.malformed;

    let added = 0;
    for (const tweet of parsed.tweets) {
      if (seenIds.has(tweet.id)) continue;
      seenIds.add(tweet.id);
      collected.push(tweet);
      added += 1;
    }
    idleRounds = added === 0 ? idleRounds + 1 : 0;

    if (collected.length >= opts.maxTweets) break;
    if (round === opts.maxScrolls) break;
    if (idleRounds >= 2) break;

    await session.browser.execute(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(1_500);
  }

  if (rawCount > 0 && collected.length === 0) {
    const evidence = await captureEvidence(session, opts.evidenceDir, `search-unparsed-${keyword}`, opts.logger);
    throw new XError(
      'X_SELECTOR_MISSING',
      `Post nodes were present for "${keyword}" but none could be parsed; the DOM likely changed.`,
      { keyword, rawCount, dropped, evidence, url },
    );
  }

  const tweets = collected.slice(0, opts.maxTweets);
  opts.logger.info('x:search', {
    stage: opts.stage,
    data: { keyword, feed: opts.feed, rawCount, tweets: tweets.length, dropped },
  });
  return { tweets, dropped };
}
