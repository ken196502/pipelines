import type { BrowserSession, CloseReport } from '../../src/lib/browser/firefox.js';
import { XError } from '../../src/lib/errors.js';
import type { ImageClient } from '../../src/lib/image/openai-images.js';
import type { LlmClient } from '../../src/lib/llm/types.js';
import type { JsonlLogger } from '../../src/lib/log/jsonl-logger.js';
import type { Tweet } from '../../src/module/x/search.js';
import type { XblogDeps } from '../../src/pipeline/xblog/deps.js';

export interface FakeXOptions {
  tweets: Tweet[];
  blockOnKeyword?: string;
  selectorMissingOnKeyword?: string;
  authError?: 'X_AUTH_REQUIRED' | 'X_CHALLENGE' | 'X_AUTH_WRONG_ACCOUNT';
  articlesUnavailable?: boolean;
  draftNotSaved?: boolean;
  premiumText?: string;
  editUrl?: string;
  imageBytes?: Buffer;
  llm?: (logger: JsonlLogger) => LlmClient;
}

export interface FakeXCalls {
  preflight: number;
  searches: string[];
  drafts: number;
  titles: string[];
  bodies: string[];
  covers: string[];
  published: number;
  closed: number;
  verified: number;
}

const CLOSE_REPORT: CloseReport = {
  firefoxPid: null,
  geckodriverPid: null,
  sessionDeleted: true,
  firefoxExited: true,
  geckodriverExited: true,
  forcedKill: false,
  errors: [],
};

export function createFakeDeps(options: FakeXOptions): { deps: XblogDeps; calls: FakeXCalls } {
  const calls: FakeXCalls = {
    preflight: 0,
    searches: [],
    drafts: 0,
    titles: [],
    bodies: [],
    covers: [],
    published: 0,
    closed: 0,
    verified: 0,
  };

  const editUrl = options.editUrl ?? 'https://x.com/compose/articles/fake-1';

  const session: BrowserSession = {
    browser: {} as WebdriverIO.Browser,
    firefoxPid: null,
    geckodriverPid: null,
    async close() {
      calls.closed += 1;
      return CLOSE_REPORT;
    },
  };

  const deps: XblogDeps = {
    session: { current: null },
    async preflight() {
      calls.preflight += 1;
    },
    async launchBrowser() {
      deps.session.current = session;
      return session;
    },
    x: {
      async ensureLoggedIn() {
        if (options.authError) {
          throw new XError(options.authError, `fake auth failure: ${options.authError}`, { mode: 'profile' });
        }
        return { handle: 'fakeuser' };
      },
      async searchKeyword(_session, keyword) {
        calls.searches.push(keyword);
        if (options.blockOnKeyword === keyword) {
          throw new XError('X_SEARCH_BLOCKED', `fake search block on ${keyword}`, { keyword });
        }
        if (options.selectorMissingOnKeyword === keyword) {
          throw new XError('X_SELECTOR_MISSING', `fake selector drift on ${keyword}`, { keyword, selector: 'tweet' });
        }
        return { tweets: options.tweets, dropped: { promoted: 0, retweet: 0, malformed: 0 } };
      },
      draft: {
        async openArticleDraft() {
          if (options.articlesUnavailable) {
            throw new XError('X_ARTICLES_UNAVAILABLE', 'fake upsell wall', {});
          }
          calls.drafts += 1;
          return { editUrl };
        },
        async setTitle(_session, title) {
          calls.titles.push(title);
        },
        async setBody(_session, markdown) {
          calls.bodies.push(markdown);
        },
        async attachCoverImage(_session, filePath) {
          calls.covers.push(filePath);
        },
        async readLeadingText() {
          return options.premiumText ?? 'A normal draft without a marker';
        },
        async waitForSaved() {
          if (options.draftNotSaved) {
            throw new XError('X_DRAFT_NOT_SAVED', 'fake draft was not saved', {});
          }
        },
        async verifyDraftListed() {
          calls.verified += 1;
          if (options.draftNotSaved) {
            throw new XError('X_DRAFT_NOT_SAVED', 'fake draft is not listed', {});
          }
          return editUrl;
        },
      },
    },
    createLlm(_profileName: string, logger: JsonlLogger): LlmClient {
      if (!options.llm) throw new Error('fake deps need an llm factory');
      return options.llm(logger);
    },
    createImageClient(_logger: JsonlLogger): ImageClient {
      return {
        async generate() {
          if (!options.imageBytes) throw new Error('fake deps need image bytes');
          return { bytes: options.imageBytes };
        },
      };
    },
  };

  return { deps, calls };
}
