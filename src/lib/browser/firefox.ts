import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { remote } from 'webdriverio';
import { BrowserError } from '../errors.js';
import type { JsonlLogger } from '../log/jsonl-logger.js';
import { processCleanup } from '../process/cleanup.js';

export interface CloseReport {
  firefoxPid: number | null;
  geckodriverPid: number | null;
  sessionDeleted: boolean;
  firefoxExited: boolean;
  geckodriverExited: boolean;
  forcedKill: boolean;
  errors: string[];
}

export interface BrowserSession {
  readonly browser: WebdriverIO.Browser;
  readonly firefoxPid: number | null;
  readonly geckodriverPid: number | null;
  close(): Promise<CloseReport>;
}

export interface LaunchOptions {
  firefoxBinary: string;
  geckodriverBinary: string;
  profileDir?: string;
  headless: boolean;
  windowSize: { width: number; height: number };
  proxy?: { http: string; https: string };
  logDir: string;
  pageLoadTimeoutMs: number;
  logger: JsonlLogger;
}

const LAUNCH_TIMEOUT_MS = 20_000;
const FIREFOX_EXIT_TIMEOUT_MS = 10_000;
const SIGTERM_GRACE_MS = 5_000;

async function assertExecutable(path: string, what: string): Promise<void> {
  try {
    await access(path, constants.X_OK);
  } catch (err) {
    throw new BrowserError('BROWSER_BINARY_MISSING', `${what} is missing or not executable: ${path}`, { path }, {
      cause: err,
    });
  }
}

async function assertProfileUnlocked(profileDir: string): Promise<void> {
  for (const lockName of ['parent.lock', 'lock']) {
    const lockPath = join(profileDir, lockName);
    try {
      await lstat(lockPath);
      throw new BrowserError(
        'BROWSER_PROFILE_LOCKED',
        `Firefox profile ${profileDir} is locked (${lockName} exists). Close the other Firefox instance; the lock is never removed automatically.`,
        { profileDir, lockPath },
      );
    } catch (err) {
      if (err instanceof BrowserError) throw err;
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new BrowserError('BROWSER_PROFILE_UNREADABLE', `Cannot inspect profile ${profileDir}.`, { profileDir }, {
          cause: err,
        });
      }
    }
  }
}

function signalPid(pid: number | null, signal: NodeJS.Signals): string | undefined {
  if (pid === null) return undefined;
  try {
    process.kill(pid, signal);
    return undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return undefined;
    return `${signal} to ${pid} failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitForExit(pid: number | null, timeoutMs: number): Promise<boolean> {
  if (pid === null) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isAlive(pid);
}

function proxyPrefs(proxy: LaunchOptions['proxy']): Record<string, unknown> {
  if (!proxy) return {};
  const http = new URL(proxy.http);
  const https = new URL(proxy.https);
  return {
    'network.proxy.type': 1,
    'network.proxy.http': http.hostname,
    'network.proxy.http_port': Number(http.port || 80),
    'network.proxy.ssl': https.hostname,
    'network.proxy.ssl_port': Number(https.port || 443),
  };
}

async function startGeckodriver(
  binary: string,
  logger: JsonlLogger,
): Promise<{ child: ChildProcess; port: number; stderr: () => string }> {
  const child = spawn(binary, ['--port', '0', '--allow-hosts', '127.0.0.1', '--log', 'info'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-20_000);
  });

  const port = await new Promise<number>((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => {
      reject(
        new BrowserError('BROWSER_LAUNCH_FAILED', `geckodriver did not start within ${LAUNCH_TIMEOUT_MS} ms.`, {
          binary,
          stderr,
        }),
      );
    }, LAUNCH_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString()}`;
      const match = /Listening on [^:\s]+:(\d+)/.exec(stdout);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(new BrowserError('BROWSER_LAUNCH_FAILED', `Cannot start geckodriver: ${err.message}`, { binary }, { cause: err }));
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(
        new BrowserError('BROWSER_LAUNCH_FAILED', `geckodriver exited before listening (code ${code}).`, {
          binary,
          stderr,
        }),
      );
    });
  });

  logger.debug('browser:geckodriver', { data: { pid: child.pid ?? null, port } });
  return { child, port, stderr: () => stderr };
}

/**
 * Launches Firefox ESR through geckodriver and a webdriverio classic session.
 * Binaries are checked first; the profile lock is never removed automatically.
 */
export async function launchFirefox(opts: LaunchOptions): Promise<BrowserSession> {
  await assertExecutable(opts.firefoxBinary, 'Firefox binary');
  await assertExecutable(opts.geckodriverBinary, 'geckodriver binary');

  let profileDir = opts.profileDir;
  if (profileDir !== undefined) {
    await mkdir(profileDir, { recursive: true });
    await assertProfileUnlocked(profileDir);
  }

  const { child, port, stderr } = await startGeckodriver(opts.geckodriverBinary, opts.logger);
  const geckodriverPid = child.pid ?? null;
  processCleanup.registerChild(child, 'geckodriver');

  const args: string[] = opts.headless ? ['-headless'] : [];
  args.push('--width', String(opts.windowSize.width), '--height', String(opts.windowSize.height));
  if (profileDir !== undefined) args.push('-profile', profileDir);

  let browser: WebdriverIO.Browser;
  try {
    browser = await remote({
      hostname: '127.0.0.1',
      port,
      path: '/',
      logLevel: 'error',
      outputDir: opts.logDir,
      capabilities: {
        browserName: 'firefox',
        'wdio:enforceWebDriverClassic': true,
        'moz:firefoxOptions': {
          binary: opts.firefoxBinary,
          args,
          prefs: {
            'browser.shell.checkDefaultBrowser': false,
            'browser.startup.homepage_override.mstone': 'ignore',
            'datareporting.policy.dataSubmissionEnabled': false,
            'toolkit.telemetry.reportingpolicy.firstRun': false,
            ...proxyPrefs(opts.proxy),
          },
        },
      },
    });
  } catch (err) {
    signalPid(geckodriverPid, 'SIGTERM');
    processCleanup.unregisterChild(child);
    throw new BrowserError('BROWSER_LAUNCH_FAILED', `Firefox session could not be created: ${stderr()}`, {
      firefoxBinary: opts.firefoxBinary,
      geckodriverBinary: opts.geckodriverBinary,
      headless: opts.headless,
    }, { cause: err });
  }

  await browser.setTimeout({ pageLoad: opts.pageLoadTimeoutMs });

  const rawPid = (browser.capabilities as Record<string, unknown>)['moz:processID'];
  const firefoxPid = typeof rawPid === 'number' ? rawPid : null;
  opts.logger.info('browser:launch', {
    data: {
      firefoxPid,
      geckodriverPid,
      port,
      headless: opts.headless,
      profileDir: profileDir ?? null,
    },
  });

  let closePromise: Promise<CloseReport> | undefined;
  const session: BrowserSession = {
    browser,
    firefoxPid,
    geckodriverPid,
    close(): Promise<CloseReport> {
      closePromise ??= (async () => {
        const errors: string[] = [];
        let sessionDeleted = false;
        try {
          await browser.deleteSession();
          sessionDeleted = true;
        } catch (err) {
          errors.push(`deleteSession failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        let firefoxExited = await waitForExit(firefoxPid, FIREFOX_EXIT_TIMEOUT_MS);
        let geckodriverExited = await waitForExit(geckodriverPid, 2_000);

        if (!firefoxExited) {
          const problem = signalPid(firefoxPid, 'SIGTERM');
          if (problem) errors.push(problem);
          firefoxExited = await waitForExit(firefoxPid, SIGTERM_GRACE_MS);
        }
        if (!geckodriverExited) {
          const problem = signalPid(geckodriverPid, 'SIGTERM');
          if (problem) errors.push(problem);
          geckodriverExited = await waitForExit(geckodriverPid, SIGTERM_GRACE_MS);
        }

        let forcedKill = false;
        if (!firefoxExited || !geckodriverExited) {
          forcedKill = true;
          for (const pid of [firefoxPid, geckodriverPid]) {
            const problem = signalPid(pid, 'SIGKILL');
            if (problem) errors.push(problem);
          }
          await waitForExit(firefoxPid, 1_000);
          await waitForExit(geckodriverPid, 1_000);
          opts.logger.warn('browser:forced-kill', { data: { firefoxPid, geckodriverPid } });
        }

        processCleanup.unregisterChild(child);
        processCleanup.unregister(session);
        const report: CloseReport = {
          firefoxPid,
          geckodriverPid,
          sessionDeleted,
          firefoxExited,
          geckodriverExited,
          forcedKill,
          errors,
        };
        opts.logger.info('browser:close', { data: report as unknown as Record<string, unknown> });
        return report;
      })();
      return closePromise;
    },
  };

  processCleanup.register(session, 'firefox session');
  return session;
}
