# Architecture

## Layers

```
pipeline/  orchestration and use cases   -> may import module/ and lib/
module/    reusable capabilities         -> may import lib/ only
lib/       primitives and integrations   -> imports only node:* and npm deps
```

- `lib` knows nothing about x.com, articles or xblog.
- `module` knows nothing about runs, stages or a specific pipeline. Module
  functions receive their dependencies (LLM client, browser session, logger) as
  parameters.
- `pipeline` wires config, storage, logging and modules into ordered stages.
- `src/cli.ts` is the entry point and may import any layer.

`tests/architecture.test.ts` enforces this: it parses every import in `src/`,
rejects upward imports (`lib -> module`, `lib -> pipeline`, `module -> pipeline`)
and any path that resolves outside the project. The same test rejects raw
`.click(` outside `module/x/safe-click.ts`, the strings `publishDraft` and
`/compose/post`, empty `catch {}` blocks and `.catch(() => ...)`.

## Errors

Every failure is a `PipelineTemplateError` with a stable `code`, a message that
says what failed and what to do, and a `context` object. The runner records it
in `run.json` and `events.jsonl`, marks the remaining stages `not-run`, runs
`finalize`, and rethrows. The CLI prints the code, the important context keys,
the run directory and evidence paths.

| Code | Layer | Meaning | User action |
|---|---|---|---|
| `CONFIG_NOT_FOUND` / `CONFIG_READ_FAILED` | lib | config file missing/unreadable | fix the path |
| `CONFIG_PARSE` | lib | invalid JSON, includes line/column | fix the file |
| `CONFIG_INVALID` | lib | schema violation, includes issue paths | fix the field |
| `ENV_MISSING` | lib | required env var missing/empty | add it to `.env` |
| `LLM_PLACEHOLDER_CONFIG` | lib | `example-gateway` / `your-model-id` still present | edit `config/llm.json` |
| `LLM_PROFILE_UNKNOWN` | lib | profile name not defined | add it or fix the reference |
| `STORAGE_UNSAFE_KEY` | lib | key is not path-segment safe | fix the key |
| `STORAGE_ROOT_INVALID` | lib | root is `/`, home or the OS temp dir | configure `storage.root` |
| `STORAGE_WRITE_FAILED` | lib | atomic write failed | check permissions/disk |
| `RUN_DIR_EXISTS` | lib | duplicate run id | use a new run id |
| `MANIFEST_CORRUPT` / `STORE_CORRUPT` | lib | file is not valid JSON/schema | inspect and repair deliberately |
| `LOG_WRITE_FAILED` | lib | event log cannot be appended | check the run directory |
| `LLM_REQUEST_FAILED` | lib | retries exhausted (transport, timeout, 429, 5xx) | check the gateway |
| `LLM_HTTP_ERROR` | lib | non-retryable 4xx | fix request/config |
| `LLM_TRUNCATED` | lib | `finish_reason=length` | raise `maxTokens` |
| `LLM_EMPTY` / `LLM_MALFORMED_RESPONSE` | lib | unusable reply | check the model/gateway |
| `LLM_INVALID_JSON` / `LLM_SCHEMA_MISMATCH` | lib | reply is not JSON or does not match the schema | see `artifacts/llm-failures/` |
| `LLM_SCORE_SET_MISMATCH` | module | scored ids differ from the input set | re-run; check the prompt/model |
| `IMAGE_INVALID_BYTES` | lib | not a PNG/JPEG/WebP or <1 KB | check the image endpoint |
| `IMAGE_EMPTY_RESPONSE` | lib | no `b64_json` and no `url` | check the endpoint |
| `IMAGE_DOWNLOAD_FAILED` | lib | generated URL could not be fetched | check connectivity |
| `BROWSER_BINARY_MISSING` | lib | Firefox/geckodriver missing or not executable | fix the config path |
| `BROWSER_PROFILE_LOCKED` | lib | Firefox already uses the profile | close it; the lock is never removed automatically |
| `BROWSER_LAUNCH_FAILED` | lib | geckodriver/session could not start | read the stderr in the context |
| `BROWSER_NAVIGATION_FAILED` / `BROWSER_NAVIGATION_TIMEOUT` | lib | navigation failed | check network/proxy |
| `BROWSER_BLANK_PAGE` | lib | retries landed on a blank page | check the URL |
| `BROWSER_SESSION_LOST` | lib | session is gone | re-run |
| `X_AUTH_REQUIRED` | module | login wall / no account switcher | `npm run xblog:login` |
| `X_CHALLENGE` | module | Cloudflare interstitial | solve it manually |
| `X_AUTH_WRONG_ACCOUNT` | module | handle differs from `expectedHandle` | fix the profile/config |
| `X_AUTH_COOKIES_INVALID` | module | cookie file invalid or rejected | fix the file |
| `X_SELECTOR_MISSING` | module | DOM drift; evidence captured | update `module/x/selectors.ts` |
| `X_SEARCH_BLOCKED` | module | rate limit / block page | wait and retry |
| `X_ARTICLES_UNAVAILABLE` | module | account not eligible for Articles | use an eligible account |
| `X_DRAFT_NOT_SAVED` | module | title/body/autosave/listing failed | inspect the editor |
| `X_COVER_NOT_ATTACHED` | module | no cover preview appeared | check the image/editor |
| `X_PUBLISH_FORBIDDEN` | module | a click looked like publish | never bypass; fix the selector/purpose |
| `XBLOG_NO_CANDIDATES` | pipeline | no new posts found | broaden keywords |
| `XBLOG_NO_RELEVANT_SOURCES` | pipeline | nothing reached `minScore` | lower the threshold or change keywords |
| `ARTICLE_LANGUAGE_MISMATCH` | module | text does not match the configured language | re-run or change `language` |
| `ARTICLE_SOURCE_IDS_INVALID` | module | model cited unknown/duplicate ids | re-run |
| `PREMIUM_MARKERS_EMPTY` | module | empty marker list | configure `premium.markers` |
| `PIPELINE_UNKNOWN` | pipeline | unknown pipeline id | use `xblog` |
| `RUN_INTERRUPTED` | pipeline | SIGINT/SIGTERM during a run | re-run |
| `UNEXPECTED_ERROR` | pipeline | a non-typed error escaped | read the stack in `run.json` |

Retries are limited to: LLM/image transport errors, timeouts, HTTP 429 and 5xx;
browser navigation timeouts and blank pages while the session is alive. Nothing
else is retried, and a retry never changes the model, selector, URL or input.

## Stages

| # | Stage | Does | Artifacts |
|---|---|---|---|
| 1 | `preflight` | checks binaries, auth assets, env vars and provider profiles; no network | `config.resolved.json` |
| 2 | `browser-launch` | launches Firefox ESR through geckodriver | webdriver logs |
| 3 | `x-auth` | verifies the session and reads the handle | `auth.json` |
| 4 | `x-search` | searches each keyword, dedupes, drops used ids | `candidates.json`, `search-stats.json` |
| 5 | `relevance` | scores candidates, keeps `>= minScore`, top `maxSources` | `scores.json`, `selected.json` |
| 6 | `article` | writes the article in the configured language | `article.json`, `article.md` |
| 7 | `image` | generates and validates the cover | `cover.png` / `.jpg` / `.webp` |
| 8 | `draft-compose` | opens the editor, sets title/body, uploads the cover | `draft.json`, evidence |
| 9 | `premium-check` | detects the configured marker in the editor and generated text | `premium.json` |
| 10 | `draft-save` | waits for autosave, verifies the draft is listed, records history | `draft.json` |
| finalize | — | closes the browser, writes `result` | `run.json` |

The pipeline store is written only in `draft-save`, after the draft is verified,
so a failed run never marks sources as used.

## Draft-only enforcement

1. No function navigates to a publish surface or clicks a publish control.
2. All clicks in `module/x` go through `safeClick`, which reads `innerText`,
   `aria-label` and `data-testid` and throws `X_PUBLISH_FORBIDDEN` when any of
   them contains publish/post/tweet/share/schedule as a word. camelCase test ids
   are split first, so `tweetButton` is caught.
3. The architecture test greps for raw `.click(` outside `safe-click.ts` and for
   `publishDraft` and `/compose/post`.

## Adding a pipeline

1. Add `src/pipeline/<id>/config.ts` with a strict zod schema.
2. Add `src/pipeline/<id>/stages.ts` with `StageDefinition` entries and an
   optional `finalize`.
3. Export a `PipelineDefinition` from `src/pipeline/<id>/index.ts` and call
   `registerPipeline` there (see `pipeline/xblog/index.ts`); import the module
   from `src/cli.ts` so registration runs.
4. Add a CLI branch if the pipeline needs pipeline-specific overrides.
5. Add tests with fake dependencies; the default suite must not need network or
   credentials.
