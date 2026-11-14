import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { StorageError } from '../errors.js';

async function writeFileDurable(file: string, data: string | Buffer): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const handle = await open(tmp, 'w');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw new StorageError('STORAGE_WRITE_FAILED', `Failed to write ${file}.`, { path: file }, { cause: err });
  }
}

/** Writes JSON with fsync + rename, so a reader never sees a half-written file. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFileDurable(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Same durability contract for binary or textual artifacts. */
export async function writeFileAtomic(file: string, data: string | Buffer): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFileDurable(file, data);
}

/** Creates `dir` and fails if it already exists. */
export async function ensureDirExclusive(dir: string): Promise<void> {
  await mkdir(dirname(dir), { recursive: true });
  try {
    await mkdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new StorageError('RUN_DIR_EXISTS', `Run directory already exists: ${dir}`, { path: dir }, { cause: err });
    }
    throw new StorageError('STORAGE_MKDIR_FAILED', `Failed to create directory ${dir}.`, { path: dir }, { cause: err });
  }
}
