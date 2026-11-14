import { homedir, tmpdir } from 'node:os';
import { isAbsolute, parse, relative, resolve } from 'node:path';
import { StorageError } from '../errors.js';

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Runtime data must live under an explicit, durable storage root. The OS temp
 * directory and the home directory are rejected: scratch paths in /tmp are how
 * data silently disappears between runs.
 */
export function assertStorageRoot(root: string): string {
  const resolved = resolve(root);
  const filesystemRoot = parse(resolved).root;
  if (resolved === filesystemRoot) {
    throw new StorageError('STORAGE_ROOT_INVALID', `Refusing to use ${resolved} as a storage root.`, { root: resolved });
  }
  if (resolved === resolve(homedir())) {
    throw new StorageError('STORAGE_ROOT_INVALID', `Refusing to use the home directory as a storage root.`, {
      root: resolved,
    });
  }
  if (isInside(resolve(tmpdir()), resolved)) {
    throw new StorageError(
      'STORAGE_ROOT_INVALID',
      `Refusing to use a temporary directory as a storage root: ${resolved}. Configure storage.root inside the project.`,
      { root: resolved },
    );
  }
  return resolved;
}
