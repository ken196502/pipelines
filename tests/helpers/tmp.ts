import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

const created: string[] = [];
const TMP_ROOT = join(process.cwd(), '.tmp');

/**
 * Scratch directories live under <project>/.tmp/test-<pid>-<random>/ so they
 * never touch the OS temp dir and are covered by .gitignore.
 */
export function makeTmpDirSync(label = 'test'): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TMP_ROOT, `${label}-${process.pid}-`));
  created.push(dir);
  return dir;
}

export async function makeTmpDir(label = 'test'): Promise<string> {
  await mkdir(TMP_ROOT, { recursive: true });
  const dir = await mkdtemp(join(TMP_ROOT, `${label}-${process.pid}-`));
  created.push(dir);
  return dir;
}

/** Removes one directory and forgets it. */
export async function removeTmpDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  const index = created.indexOf(dir);
  if (index >= 0) created.splice(index, 1);
}

/** Removes every directory created by this process. Safe to call twice. */
export async function cleanupTmpDirs(): Promise<void> {
  const dirs = created.splice(0, created.length);
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true });
  }
}

// A crashed test still cleans up: node runs 'exit' handlers synchronously.
process.on('exit', () => {
  for (const dir of created.splice(0, created.length)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      process.stderr.write(`tmp cleanup failed for ${dir}: ${String(err)}\n`);
    }
  }
});
