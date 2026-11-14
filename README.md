# pipeline-template

A standalone TypeScript template for browser-driven content pipelines. It ships
one pipeline, `xblog`, which searches x.com, ranks the results with an
LLM, writes an article, generates a cover image and **saves a draft in the X
Articles editor**. It never publishes.

The project is self-contained: its own `package.json`, lockfile, `node_modules`,
Git repository and storage. It does not import anything from a parent project.

## Prerequisites

- Node.js 22 or newer (ESM).
- Firefox ESR, for example `/usr/bin/firefox-esr` (tested with 153.4.0esr).
- A geckodriver binary. The runtime never downloads it; fetch it once with
  `npm run setup:geckodriver`, which writes `.cache/geckodriver/geckodriver`.
- An OpenAI-compatible chat endpoint and an OpenAI-compatible image endpoint.
- An X account that is eligible for X Articles.

## Setup

```bash
npm install
cp .env.example .env          # fill in gateway URLs and API keys
npm run setup:geckodriver     # downloads geckodriver into .cache/
# edit config/llm.json: model ids and the env var names for base URLs and keys
# edit config/xblog.json: binaries, keywords, thresholds, auth mode
npm run xblog:login           # once, opens a headed Firefox and saves the profile
```

`npm run xblog:login` opens `https://x.com/login` in a headed browser. Log in by
hand; the command waits until the account switcher appears (up to 10 minutes),
prints the handle and closes Firefox cleanly. The session lives in the profile
directory from `auth.profileDir`.

npm scripts load `.env` explicitly with `--env-file=.env`. If `.env` is missing,
Node fails loudly; the CLI never invents defaults for secrets.

## Environment variables

| Variable | Used by |
|---|---|
| `LLM_BASE_URL` | chat gateway root named by `llm.profiles.<name>.baseUrlEnv` |
| `LLM_API_KEY` | chat profile named by `llm.profiles.<name>.apiKeyEnv` |
| `IMAGE_BASE_URL` | image gateway root named by `llm.image.baseUrlEnv` |
| `IMAGE_API_KEY` | image profile `llm.image.apiKeyEnv` |

The variable names come from `config/llm.json`; the values live only in `.env`,
which is git-ignored.

## Configuration

All config files are strict JSON: an unknown key is an error, not a warning.

### `config/llm.json`

| Field | Meaning |
|---|---|
| `profiles.<name>.apiStyle` | must be `openai-chat` |
| `profiles.<name>.baseUrlEnv` | environment variable holding the gateway root, e.g. `https://gateway.example/v1` |
| `profiles.<name>.apiKeyEnv` | environment variable holding the key |
| `profiles.<name>.model` | model id |
| `profiles.<name>.timeoutMs` | per-request timeout |
| `profiles.<name>.maxRetries` | retries for transport errors, timeout, 429 and 5xx |
| `profiles.<name>.retryBaseDelayMs` | exponential backoff base |
| `image.apiStyle` | must be `openai-images` |
| `image.baseUrlEnv` / `apiKeyEnv` / `model` | image endpoint settings; the URL and key come from the named env vars |
| `image.size` | requested image size, e.g. `1536x1024` |
| `image.timeoutMs` / `maxRetries` | image request budget |

The committed model ids are placeholders (`your-model-id`, `your-image-model-id`).
A base URL whose host is `example-gateway` is rejected the same way. Both fail
before any network call with `LLM_PLACEHOLDER_CONFIG`. The gateway roots
themselves live in `.env` (`LLM_BASE_URL`, `IMAGE_BASE_URL`).

### `config/xblog.json`

| Field | Meaning |
|---|---|
| `language` | `en` or `zh`; controls the article prompt and the language check |
| `keywords` | non-empty, unique search terms |
| `storage.root` | runtime data root |
| `llm.profilesFile` | path to the LLM config |
| `llm.relevance` / `llm.article` | chat profile names |
| `browser.firefoxBinary` | Firefox ESR executable |
| `browser.geckodriverBinary` | geckodriver executable |
| `browser.headless` | headless mode; `--headed` forces `false` |
| `browser.windowSize` | window size passed to Firefox |
| `browser.pageLoadTimeoutMs` | page load timeout |
| `browser.proxy` | `{ "http": "...", "https": "..." }` or `null`; nothing is hardcoded |
| `auth.mode` | `profile` (persistent profile) or `cookies` (explicit JSON file) |
| `auth.profileDir` | profile directory, required in `profile` mode |
| `auth.cookiesFile` | cookie file, required in `cookies` mode |
| `auth.expectedHandle` | optional handle assertion |
| `search.feed` | `top` or `live` |
| `search.tweetsPerKeyword` | posts collected per keyword |
| `search.maxScrolls` | scroll rounds per keyword |
| `search.useLangOperator` | adds `lang:<code>` to the query; off by default |
| `relevance.minScore` | minimum score (0-10) to keep a source |
| `relevance.maxSources` | sources passed to the article |
| `relevance.batchSize` | candidates per scoring call |
| `relevance.maxTokens` | scoring call budget |
| `relevance.excludeUsedSources` | drop ids recorded in `history/used-sources` |
| `article.minChars` / `maxChars` | accepted body length |
| `article.maxTokens` | article call budget |
| `premium.markers` | non-empty list of literal prefixes to detect |
| `draft.saveTimeoutMs` | how long to wait for the editor's "Saved" indicator |
| `logging.saveLlmTranscripts` | write full prompts/responses under `artifacts/llm/` |

Relative paths are resolved against the **config file's directory** and recorded
in absolute form in the run manifest. That is why the committed
`config/xblog.json` uses `../data` and `./llm.json`.

## Commands

```bash
npm run xblog                 # run with config/xblog.json
npm run xblog -- --language zh --keywords "MCP,agent memory" --headed
npm run xblog:login           # headed login, profile mode only
npm run runs -- xblog         # list runs: id, status, failed stage, draft URL
npm run setup:geckodriver
npm run typecheck
npm test
npm run test:browser          # opt-in real Firefox against local fixtures
```

CLI overrides are `--config <path>`, `--language <code>`, `--keywords "a,b"` and
`--headed`. They are re-validated with the same schema and recorded in
`run.json.overrides`. An unknown subcommand, pipeline id or flag exits with 2;
a failed run exits with 1; a config error exits with 2.

## Storage layout

Everything runtime lives under `storage.root` (`./data` by default), which is
git-ignored:

```
data/
├── pipelines/
│   └── xblog/
│       ├── store/
│       │   └── history/
│       │       ├── used-sources.json
│       │       └── drafts.json
│       └── runs/
│           └── <runId>/
│               ├── run.json            # manifest, atomically rewritten
│               ├── events.jsonl        # append-only event log
│               ├── artifacts/          # candidates, scores, article, cover, ...
│               ├── evidence/           # screenshots + page dumps on failures
│               └── webdriver/          # webdriver logs for the run
├── browser-profiles/x/                 # persistent Firefox profile
└── logs/                               # login logs
```

## Event log

`events.jsonl` has one JSON object per line:

```json
{"seq":1,"ts":"2026-11-13T15:00:00.000Z","runId":"...","pipelineId":"xblog",
 "level":"info","event":"stage:start","stage":"preflight","data":{...}}
```

`seq` is monotonic per run. Fields are `level` (`debug|info|warn|error`),
`event` (`run:start`, `stage:start`, `stage:end`, `stage:error`, `llm:request`,
`llm:retry`, `llm:response`, `browser:launch`, `browser:close`,
`browser:forced-kill`, `x:auth-ok`, `x:search`, `x:search-empty`,
`image:request`, `image:response`, `run:end`), optional `stage`, optional `data`
and optional `error` (`{name, code, message, context, stack, cause}`).
Keys matching `api[-_]?key|authorization|cookie|token|password` are redacted.
Prompts are never logged in full unless `logging.saveLlmTranscripts` is true.

## Reading a failed run

1. `npm run runs -- xblog` shows the failed stage and the draft URL.
2. Open `data/pipelines/xblog/runs/<runId>/run.json`: `error` has the code and
   context, `stages` shows `failed` and `not-run` entries.
3. Read the tail of `events.jsonl` for the same stage.
4. Look in `evidence/` for a screenshot and `page.json` (URL, title, body text).

## Draft-only guarantees

- No code path navigates to a publish surface or clicks a publish control.
- Every click in `module/x` goes through `safeClick`, which refuses elements
  whose text, `aria-label` or `data-testid` mentions publish, post, tweet, share
  or schedule (`X_PUBLISH_FORBIDDEN`).
- `tests/architecture.test.ts` fails on raw `.click(` outside `safe-click.ts`
  and on the strings `publishDraft` and `/compose/post`.

## Tests

```bash
bash scripts/check-leaks.sh   # must be clean before and after
npm test                      # 101 unit/integration tests, no network
bash scripts/check-leaks.sh
npm run test:browser          # real Firefox against local fixtures only
bash scripts/check-leaks.sh
ls .tmp                       # no test-* directories remain
```

The default suite uses a fake OpenAI server on `127.0.0.1`, in-memory X fakes and
local HTML fixtures. It never contacts x.com, an LLM gateway or an image API.

`npm run test:browser` is skipped unless `XBLOG_BROWSER_SMOKE=1`. It launches the
real Firefox ESR and geckodriver against `http://127.0.0.1` fixtures, then
asserts that both PIDs are gone and the temporary profile was removed.

## Limitations

- x.com selectors change without notice. A change fails loudly with
  `X_SELECTOR_MISSING` plus evidence and is fixed in `module/x/selectors.ts`.
- X Articles requires an eligible account; otherwise `draft-compose` fails with
  `X_ARTICLES_UNAVAILABLE`.
- Cloudflare challenges and search rate limits fail the run; they are not
  bypassed.
- The language check is a CJK/Latin script-ratio heuristic, not a language
  identifier.
- Only OpenAI-compatible chat-completions and image-generation endpoints are
  supported. There is no streaming.
- One run at a time per browser profile, because Firefox locks the profile.
- The body is inserted into the editor with `innerHTML` plus an `input` event.
  This works with the fixtures and is the documented mechanism for the editor;
  the live DOM must be re-verified manually.
- The "Sources" list is appended after the `article.maxChars` check, so the
  final body can exceed that limit by the length of the citation list.
- The automated tests never touch x.com.

## Live verification

The live x.com flow is verified manually, never in automated tests:

```bash
npm run xblog:login
npm run xblog -- --headed
```

Check the draft in the X UI: it must be in Drafts, and nothing must appear on the
profile timeline. Record the run id here after the first successful manual run:

- Verified on: _not yet verified against live x.com._
