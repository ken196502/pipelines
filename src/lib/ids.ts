import { randomBytes } from 'node:crypto';
import { StorageError } from './errors.js';

const SAFE_KEY = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const GENERATED_RUN_ID = /^[0-9]{8}T[0-9]{6}[0-9]{3}Z-[0-9a-f]{6}$/;

/**
 * Run identifiers sort lexicographically by creation time:
 * YYYYMMDDTHHMMSSmmmZ-<6 hex>
 */
export function newRunId(now: Date = new Date()): string {
  const iso = now.toISOString(); // 2026-11-13T15:33:16.010Z
  const compact = iso.replace(/[-:]/g, '').replace('.', ''); // 20261113T153316010Z
  return `${compact}-${randomBytes(3).toString('hex')}`;
}

/**
 * Guards every key that ends up in a file path. Rejects empty strings,
 * traversal, separators and uppercase names.
 */
export function assertSafeKey(key: string): string {
  if (!SAFE_KEY.test(key)) {
    throw new StorageError(
      'STORAGE_UNSAFE_KEY',
      `Unsafe storage key ${JSON.stringify(key)}. Keys must match ${SAFE_KEY.source}.`,
      { key },
    );
  }
  return key;
}

/**
 * Run ids are either generated (uppercase T/Z separators) or an explicit safe
 * key supplied by a caller. Both forms are path-segment safe.
 */
export function assertSafeRunId(runId: string): string {
  if (GENERATED_RUN_ID.test(runId) || SAFE_KEY.test(runId)) return runId;
  throw new StorageError(
    'STORAGE_UNSAFE_KEY',
    `Unsafe run id ${JSON.stringify(runId)}. Expected ${GENERATED_RUN_ID.source} or ${SAFE_KEY.source}.`,
    { runId },
  );
}
