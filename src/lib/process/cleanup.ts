import type { ChildProcess } from 'node:child_process';

export interface CleanupTarget {
  close(): Promise<unknown>;
}

export interface ShutdownOptions {
  /** Called after every browser is closed, e.g. to flush the run manifest. */
  onInterrupt?: (signal: NodeJS.Signals | 'beforeExit') => Promise<void>;
}

/**
 * Tracks processes and sessions that must not outlive the CLI. Signal handlers
 * close everything, flush the manifest and exit with the conventional code.
 */
export class ProcessCleanup {
  #targets = new Map<CleanupTarget, string>();
  #children = new Map<ChildProcess, string>();
  #installed = false;
  #shuttingDown = false;
  #options: ShutdownOptions = {};
  #handlers: Partial<Record<NodeJS.Signals | 'beforeExit', () => void>> = {};

  register(target: CleanupTarget, name: string): void {
    this.#targets.set(target, name);
  }

  unregister(target: CleanupTarget): void {
    this.#targets.delete(target);
  }

  registerChild(child: ChildProcess, name: string): void {
    this.#children.set(child, name);
  }

  unregisterChild(child: ChildProcess): void {
    this.#children.delete(child);
  }

  get size(): number {
    return this.#targets.size + this.#children.size;
  }

  install(options: ShutdownOptions = {}): void {
    if (this.#installed) return;
    this.#installed = true;
    this.#options = options;

    const onSignal = (signal: NodeJS.Signals) => {
      if (this.#shuttingDown) return;
      void this.#shutdown(signal, signal === 'SIGINT' ? 130 : 143);
    };
    const onBeforeExit = () => {
      if (this.#shuttingDown) return;
      if (this.size === 0) return;
      void this.#shutdown('beforeExit', 1);
    };

    this.#handlers = { SIGINT: () => onSignal('SIGINT'), SIGTERM: () => onSignal('SIGTERM'), beforeExit: onBeforeExit };
    process.on('SIGINT', this.#handlers.SIGINT as () => void);
    process.on('SIGTERM', this.#handlers.SIGTERM as () => void);
    process.on('beforeExit', this.#handlers.beforeExit as () => void);
  }

  uninstall(): void {
    if (!this.#installed) return;
    this.#installed = false;
    process.off('SIGINT', this.#handlers.SIGINT as () => void);
    process.off('SIGTERM', this.#handlers.SIGTERM as () => void);
    process.off('beforeExit', this.#handlers.beforeExit as () => void);
    this.#handlers = {};
  }

  async #shutdown(signal: NodeJS.Signals | 'beforeExit', exitCode: number): Promise<void> {
    this.#shuttingDown = true;
    for (const [target, name] of this.#targets) {
      try {
        await target.close();
      } catch (err) {
        process.stderr.write(`cleanup: failed to close ${name}: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    this.#targets.clear();

    for (const [child, name] of this.#children) {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGTERM');
        } catch (err) {
          process.stderr.write(`cleanup: failed to stop ${name}: ${String(err)}\n`);
        }
      }
    }
    this.#children.clear();

    if (this.#options.onInterrupt) {
      try {
        await this.#options.onInterrupt(signal);
      } catch (err) {
        process.stderr.write(
          `cleanup: failed to persist interrupted state: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }

    process.exit(exitCode);
  }
}

export const processCleanup = new ProcessCleanup();
