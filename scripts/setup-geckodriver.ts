import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { download } from 'geckodriver';

/**
 * Downloads geckodriver into .cache/geckodriver/ and prints the absolute path
 * to use as browser.geckodriverBinary. Runtime code never downloads anything.
 */
const cacheDir = join(process.cwd(), '.cache', 'geckodriver');
await mkdir(cacheDir, { recursive: true });

const downloaded = await download(undefined, cacheDir);
const target = join(cacheDir, 'geckodriver');
await copyFile(downloaded, target);
await chmod(target, 0o755);

process.stdout.write(`${target}\n`);
