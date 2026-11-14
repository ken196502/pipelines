import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { launchFirefox, type BrowserSession, type LaunchOptions } from '../../lib/browser/firefox.js';
import { ConfigError } from '../../lib/errors.js';
import { createOpenAiImageClient, type ImageClient } from '../../lib/image/openai-images.js';
import { resolveImageProfile, resolveProfile, type LlmConfig } from '../../lib/llm/config.js';
import { createOpenAiCompatibleClient } from '../../lib/llm/openai-compatible.js';
import type { LlmClient } from '../../lib/llm/types.js';
import type { JsonlLogger } from '../../lib/log/jsonl-logger.js';
import { ensureLoggedIn } from '../../module/x/auth.js';
import {
  attachCoverImage,
  openArticleDraft,
  readLeadingText,
  setBody,
  setTitle,
  verifyDraftListed,
  waitForSaved,
} from '../../module/x/draft-editor.js';
import { searchKeyword } from '../../module/x/search.js';
import type { XblogConfig } from './config.js';

/**
 * Every external capability the xblog pipeline needs, as an injectable seam.
 * Tests replace this object; production wiring is the thin layer below.
 */
export interface XblogDeps {
  /** Network-free checks: binaries, auth assets, LLM/image profile resolution. */
  preflight(): Promise<void>;
  launchBrowser(opts: LaunchOptions): Promise<BrowserSession>;
  session: { current: BrowserSession | null };
  x: {
    ensureLoggedIn: typeof ensureLoggedIn;
    searchKeyword: typeof searchKeyword;
    draft: {
      openArticleDraft: typeof openArticleDraft;
      setTitle: typeof setTitle;
      setBody: typeof setBody;
      attachCoverImage: typeof attachCoverImage;
      readLeadingText: typeof readLeadingText;
      waitForSaved: typeof waitForSaved;
      verifyDraftListed: typeof verifyDraftListed;
    };
  };
  createLlm(profileName: string, logger: JsonlLogger): LlmClient;
  createImageClient(logger: JsonlLogger): ImageClient;
}

async function assertExecutable(path: string, field: string): Promise<void> {
  try {
    await access(path, constants.X_OK);
  } catch (err) {
    throw new ConfigError('CONFIG_INVALID', `${field} is missing or not executable: ${path}`, { path, field }, {
      cause: err,
    });
  }
}

export function createRealDeps(config: XblogConfig, llmConfig: LlmConfig): XblogDeps {
  return {
    session: { current: null },
    async preflight() {
      await assertExecutable(config.browser.firefoxBinary, 'browser.firefoxBinary');
      await assertExecutable(config.browser.geckodriverBinary, 'browser.geckodriverBinary');

      if (config.auth.mode === 'profile') {
        if (config.auth.profileDir === null) {
          throw new ConfigError('CONFIG_INVALID', 'auth.profileDir is required in profile mode.', {});
        }
        try {
          await access(config.auth.profileDir);
        } catch (err) {
          throw new ConfigError(
            'AUTH_PROFILE_MISSING',
            `Firefox profile ${config.auth.profileDir} does not exist. Run "npm run xblog:login" once.`,
            { profileDir: config.auth.profileDir },
            { cause: err },
          );
        }
      } else {
        if (config.auth.cookiesFile === null) {
          throw new ConfigError('CONFIG_INVALID', 'auth.cookiesFile is required in cookies mode.', {});
        }
        try {
          await access(config.auth.cookiesFile);
        } catch (err) {
          throw new ConfigError('CONFIG_INVALID', `Cookies file ${config.auth.cookiesFile} does not exist.`, {
            cookiesFile: config.auth.cookiesFile,
          }, { cause: err });
        }
      }

      // Resolving the profiles checks the env vars and rejects placeholders.
      resolveProfile(llmConfig, config.llm.relevance);
      resolveProfile(llmConfig, config.llm.article);
      resolveImageProfile(llmConfig);
    },
    launchBrowser: (opts) => launchFirefox(opts),
    x: {
      ensureLoggedIn,
      searchKeyword,
      draft: {
        openArticleDraft,
        setTitle,
        setBody,
        attachCoverImage,
        readLeadingText,
        waitForSaved,
        verifyDraftListed,
      },
    },
    createLlm: (profileName, logger) => createOpenAiCompatibleClient(resolveProfile(llmConfig, profileName), logger),
    createImageClient: (logger) => createOpenAiImageClient(resolveImageProfile(llmConfig), logger),
  };
}
