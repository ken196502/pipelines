import { z } from 'zod';
import type { PipelineStore } from '../../lib/storage/pipeline-store.js';

export const usedSourcesSchema = z.object({ ids: z.array(z.string().min(1)) }).strict();
export type UsedSources = z.infer<typeof usedSourcesSchema>;

export const draftEntrySchema = z
  .object({
    runId: z.string().min(1),
    editUrl: z.string().min(1),
    sourceIds: z.array(z.string().min(1)),
    title: z.string().min(1),
    premium: z.object({ detected: z.boolean(), marker: z.string().optional() }).strict(),
  })
  .strict();
export type DraftEntry = z.infer<typeof draftEntrySchema>;

export const draftsSchema = z.object({ drafts: z.array(draftEntrySchema) }).strict();
export type Drafts = z.infer<typeof draftsSchema>;

const NAMESPACE = 'history';

export async function readUsedSources(store: PipelineStore): Promise<string[]> {
  const value = await store.readJson(NAMESPACE, 'used-sources', usedSourcesSchema);
  return value?.ids ?? [];
}

export async function readDrafts(store: PipelineStore): Promise<DraftEntry[]> {
  const value = await store.readJson(NAMESPACE, 'drafts', draftsSchema);
  return value?.drafts ?? [];
}

/**
 * Appends a verified draft and marks its sources as used. Called only after the
 * draft is listed, so a failed run never consumes sources.
 */
export async function recordDraft(
  store: PipelineStore,
  entry: DraftEntry,
  sourceIds: readonly string[],
): Promise<void> {
  const drafts = await readDrafts(store);
  drafts.push(entry);
  await store.writeJson(NAMESPACE, 'drafts', { drafts } satisfies Drafts);

  const used = new Set(await readUsedSources(store));
  for (const id of sourceIds) used.add(id);
  await store.writeJson(NAMESPACE, 'used-sources', { ids: [...used] } satisfies UsedSources);
}
