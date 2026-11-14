#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { launchFirefox } from './lib/browser/firefox.js';
import { navigateWithRetry } from './lib/browser/navigation.js';
import { readJsonConfig } from './lib/config/load.js';
import { ConfigError, PipelineTemplateError, toLogError } from './lib/errors.js';
import { llmConfigSchema } from './lib/llm/config.js';
import { JsonlLogger } from './lib/log/jsonl-logger.js';
import { processCleanup } from './lib/process/cleanup.js';
import { RunStore } from './lib/storage/run-store.js';
import { waitForManualLogin } from './module/x/auth.js';
import { X_BASE_URL } from './module/x/search.js';
import { getPipeline } from './pipeline/core/registry.js';
import { runPipeline } from './pipeline/core/runner.js';
import { applyOverrides, resolveConfigPaths, type XblogConfig } from './pipeline/xblog/config.js';
import { createRealDeps, type XblogDeps } from './pipeline/xblog/deps.js';
import './pipeline/xblog/index.js';
import type { XblogState } from './pipeline/xblog/stages.js';

const USAGE = `Usage:
  cli run <pipeline> --config <path> [--language <code>] [--keywords "a,b"] [--headed]
  cli login <pipeline> --config <path>
  cli runs <pipeline> [--config <path>]

The only pipeline in v1 is "xblog".`;

const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

interface ParsedCli {
  command: string;
  pipelineId: string;
  configPath?: string;
  language?: string;
  keywords?: string;
  headed: boolean;
}

function parseCli(argv: string[]): ParsedCli | string {
  let values: {
    config?: string;
    language?: string;
    keywords?: string;
    headed?: boolean;
  };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        config: { type: 'string' },
        language: { type: 'string' },
        keywords: { type: 'string' },
        headed: { type: 'boolean' },
      },
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (err) {
    return `${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`;
  }

  const [command, pipelineId] = positionals;
  if (!command || !pipelineId) return USAGE;
  if (positionals.length > 2) return `Unexpected argument "${positionals[2]}".\n\n${USAGE}`;

  return {
    command,
    pipelineId,
    ...(values.config ? { configPath: values.config } : {}),
    ...(values.language ? { language: values.language } : {}),
    ...(values.keywords ? { keywords: values.keywords } : {}),
    headed: values.headed === true,
  };
}

function printError(err: unknown): number {
  if (!(err instanceof PipelineTemplateError)) {
    process.stderr.write(`Unexpected error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    return EXIT_FAILURE;
  }
  process.stderr.write(`${err.code}: ${err.message}\n`);
  const keys = [
    'stage',
    'url',
    'selector',
    'path',
    'runDir',
    'attempts',
    'lastStatus',
    'lastCause',
    'missing',
    'extra',
    'profileDir',
    'cookiesFile',
    'minScore',
    'bestScore',
  ];
  for (const key of keys) {
    const value = err.context[key];
    if (value !== undefined) process.stderr.write(`  ${key}: ${JSON.stringify(value)}\n`);
  }
  const evidence = err.context.evidence as { screenshot?: string; page?: string } | undefined;
  if (evidence?.screenshot) process.stderr.write(`  evidence screenshot: ${evidence.screenshot}\n`);
  if (evidence?.page) process.stderr.write(`  evidence page: ${evidence.page}\n`);
  return err instanceof ConfigError ? EXIT_USAGE : EXIT_FAILURE;
}

async function loadXblog(configPath: string, cli: ParsedCli): Promise<{ config: XblogConfig; overrides: Record<string, unknown> }> {
  const definition = getPipeline<XblogConfig, XblogDeps, XblogState>('xblog');
  const raw = await readJsonConfig(configPath, definition.configSchema);
  const applied = applyOverrides(raw, {
    ...(cli.language ? { language: cli.language } : {}),
    ...(cli.keywords ? { keywords: cli.keywords } : {}),
    ...(cli.headed ? { headed: true } : {}),
  });
  return { config: resolveConfigPaths(applied.config, dirname(configPath)), overrides: applied.recorded };
}

async function runCommand(cli: ParsedCli): Promise<number> {
  if (cli.pipelineId !== 'xblog') {
    getPipeline(cli.pipelineId);
    throw new ConfigError('PIPELINE_UNSUPPORTED', `CLI overrides are only implemented for xblog.`, {
      pipelineId: cli.pipelineId,
    });
  }
  if (!cli.configPath) {
    process.stderr.write(`--config is required.\n\n${USAGE}\n`);
    return EXIT_USAGE;
  }
  const configPath = resolve(cli.configPath);
  const { config, overrides } = await loadXblog(configPath, cli);
  const llmConfig = await readJsonConfig(config.llm.profilesFile, llmConfigSchema);
  const definition = getPipeline<XblogConfig, XblogDeps, XblogState>('xblog');
  const deps = createRealDeps(config, llmConfig);

  let activeRun: RunStore | undefined;
  processCleanup.install({
    onInterrupt: async (signal) => {
      if (!activeRun) return;
      await activeRun.updateManifest({
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error: toLogError(
          new PipelineTemplateError('RUN_INTERRUPTED', `Run interrupted by ${signal}.`, { signal }),
        ),
      });
    },
  });

  try {
    const outcome = await runPipeline({
      definition,
      configPath,
      config,
      overrides,
      deps,
      storageRoot: config.storage.root,
      mirror: true,
      saveLlmTranscripts: config.logging.saveLlmTranscripts,
      onRunCreated: (run) => {
        activeRun = run;
      },
    });
    process.stdout.write(`Run ${outcome.runId} succeeded.\n`);
    process.stdout.write(`Run directory: ${outcome.runDir}\n`);
    return EXIT_OK;
  } finally {
    activeRun = undefined;
    processCleanup.uninstall();
  }
}

async function loginCommand(cli: ParsedCli): Promise<number> {
  if (cli.pipelineId !== 'xblog') {
    getPipeline(cli.pipelineId);
    throw new ConfigError('PIPELINE_UNSUPPORTED', 'Only the xblog pipeline has a login command.', {
      pipelineId: cli.pipelineId,
    });
  }
  if (!cli.configPath) {
    process.stderr.write(`--config is required.\n\n${USAGE}\n`);
    return EXIT_USAGE;
  }
  const configPath = resolve(cli.configPath);
  const { config } = await loadXblog(configPath, cli);
  if (config.auth.mode !== 'profile') {
    throw new ConfigError('AUTH_MODE_INVALID', 'login requires auth.mode "profile" in the config.', {
      mode: config.auth.mode,
    });
  }
  if (!config.auth.profileDir) {
    throw new ConfigError('CONFIG_INVALID', 'auth.profileDir is required in profile mode.', {});
  }

  const logger = new JsonlLogger({
    file: join(config.storage.root, 'logs', `login-${Date.now()}.jsonl`),
    runId: `login-${Date.now()}`,
    pipelineId: 'xblog',
    mirror: true,
  });

  processCleanup.install();
  const session = await launchFirefox({
    firefoxBinary: config.browser.firefoxBinary,
    geckodriverBinary: config.browser.geckodriverBinary,
    profileDir: config.auth.profileDir,
    headless: false,
    windowSize: config.browser.windowSize,
    ...(config.browser.proxy ? { proxy: config.browser.proxy } : {}),
    logDir: join(config.storage.root, 'logs', 'webdriver'),
    pageLoadTimeoutMs: config.browser.pageLoadTimeoutMs,
    logger,
  });

  try {
    await navigateWithRetry(session.browser, {
      url: `${X_BASE_URL}/login`,
      logger,
      stage: 'login',
      maxAttempts: 1,
    });
    const { handle } = await waitForManualLogin(session, { logger, timeoutMs: 10 * 60 * 1000 });
    process.stdout.write(`\nLogged in as @${handle}. Profile: ${config.auth.profileDir}\n`);
    return EXIT_OK;
  } finally {
    const report = await session.close();
    if (report.errors.length > 0) {
      process.stderr.write(`Browser close reported problems: ${report.errors.join('; ')}\n`);
    }
    logger.close();
    processCleanup.uninstall();
  }
}

async function runsCommand(cli: ParsedCli): Promise<number> {
  const configPath = cli.configPath ? resolve(cli.configPath) : undefined;
  let storageRoot = join(process.cwd(), 'data');
  if (configPath) {
    const { config } = await loadXblog(configPath, cli);
    storageRoot = config.storage.root;
  }
  const runsDir = join(storageRoot, 'pipelines', cli.pipelineId, 'runs');

  let ids: string[];
  try {
    ids = (await readdir(runsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      process.stdout.write(`No runs found in ${runsDir}\n`);
      return EXIT_OK;
    }
    throw err;
  }

  let code = EXIT_OK;
  for (const id of ids) {
    const manifestPath = join(runsDir, id, 'run.json');
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        status?: string;
        stages?: Array<{ id: string; status: string }>;
        result?: { draftUrl?: string | null };
      };
      const failed = manifest.stages?.find((stage) => stage.status === 'failed');
      const draft = manifest.result?.draftUrl ?? '-';
      process.stdout.write(
        `${id}\t${manifest.status ?? 'unknown'}\tfailed=${failed ? `${failed.id} (${failed.status})` : '-'}\tdraft=${draft}\n`,
      );
    } catch (err) {
      process.stderr.write(`${id}\tunreadable run.json: ${err instanceof Error ? err.message : String(err)}\n`);
      code = EXIT_FAILURE;
    }
  }
  return code;
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseCli(argv);
  if (typeof parsed === 'string') {
    process.stderr.write(`${parsed}\n`);
    return EXIT_USAGE;
  }

  try {
    if (parsed.command === 'run') return await runCommand(parsed);
    if (parsed.command === 'login') return await loginCommand(parsed);
    if (parsed.command === 'runs') return await runsCommand(parsed);
    process.stderr.write(`Unknown command "${parsed.command}".\n\n${USAGE}\n`);
    return EXIT_USAGE;
  } catch (err) {
    return printError(err);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exitCode = EXIT_FAILURE;
  },
);
