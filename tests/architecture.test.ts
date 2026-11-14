import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, it } from 'node:test';

const projectRoot = process.cwd();
const srcRoot = join(projectRoot, 'src');

async function listTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listTsFiles(full)));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(full);
  }
  return files.sort();
}

const RANK: Record<string, number> = { lib: 0, module: 1, pipeline: 2, cli: 3 };

function layerOf(file: string): string {
  const rel = relative(srcRoot, file);
  const first = rel.split(sep)[0] ?? '';
  return first.endsWith('.ts') ? 'cli' : first;
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)) {
    if (match[1]) specifiers.push(match[1]);
  }
  for (const match of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) {
    if (match[1]) specifiers.push(match[1]);
  }
  return specifiers;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && rel !== '..');
}

describe('architecture', () => {
  it('only imports downward: lib <- module <- pipeline', async () => {
    const files = await listTsFiles(srcRoot);
    assert.ok(files.length > 0);
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const fromLayer = layerOf(file);
      for (const specifier of importSpecifiers(source)) {
        if (!specifier.startsWith('.')) continue;
        const target = resolve(dirname(file), specifier);
        if (!isInside(projectRoot, target)) {
          violations.push(`${relative(projectRoot, file)} imports outside the project: ${specifier}`);
          continue;
        }
        if (!isInside(srcRoot, target)) {
          violations.push(`${relative(projectRoot, file)} imports outside src/: ${specifier}`);
          continue;
        }
        const toLayer = layerOf(target);
        const fromRank = RANK[fromLayer];
        const toRank = RANK[toLayer];
        if (fromRank === undefined || toRank === undefined) {
          violations.push(`${relative(projectRoot, file)} imports from unknown layer ${toLayer}: ${specifier}`);
          continue;
        }
        if (toRank > fromRank) {
          violations.push(`${relative(projectRoot, file)} (${fromLayer}) imports upward from ${toLayer}: ${specifier}`);
        }
      }
    }

    assert.deepEqual(violations, []);
  });

  it('never clicks directly outside safe-click.ts', async () => {
    const files = await listTsFiles(srcRoot);
    const violations: string[] = [];
    for (const file of files) {
      if (file.endsWith(join('module', 'x', 'safe-click.ts'))) continue;
      const source = await readFile(file, 'utf8');
      if (/\.click\s*\(/.test(source)) {
        violations.push(`${relative(projectRoot, file)} calls .click() directly; use safeClick()`);
      }
    }
    assert.deepEqual(violations, []);
  });

  it('contains no publish paths or publish helpers', async () => {
    const files = await listTsFiles(srcRoot);
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const banned of ['publishDraft', '/compose/post']) {
        if (source.includes(banned)) {
          violations.push(`${relative(projectRoot, file)} contains ${banned}`);
        }
      }
    }
    assert.deepEqual(violations, []);
  });

  it('contains no swallowed errors in src/', async () => {
    const files = await listTsFiles(srcRoot);
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (/catch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(source)) {
        violations.push(`${relative(projectRoot, file)} has an empty catch block`);
      }
      if (/\.catch\(\s*\(\s*\)\s*=>/.test(source)) {
        violations.push(`${relative(projectRoot, file)} swallows a rejection with .catch(() => ...)`);
      }
    }
    assert.deepEqual(violations, []);
  });
});
