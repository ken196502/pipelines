import { z } from 'zod';
import { LlmError } from '../../lib/errors.js';
import { chatJson } from '../../lib/llm/json.js';
import type { ChatContext, LlmClient } from '../../lib/llm/types.js';

export interface ScoreCandidate {
  id: string;
  text: string;
  author?: string;
  url?: string;
}

export interface ScoredCandidate {
  id: string;
  score: number;
  reason: string;
}

export interface ScoreOptions {
  topicKeywords: string[];
  language: string;
  candidates: ScoreCandidate[];
  maxTokens: number;
  /** Chunk size for candidate batches; comes from config. */
  batchSize: number;
  context: ChatContext;
  sink?: (raw: string) => Promise<string>;
}

const scoresSchema = z
  .object({
    scores: z.array(
      z
        .object({
          id: z.string().min(1),
          score: z.number().int().min(0).max(10),
          reason: z.string().min(10).max(400),
        })
        .strict(),
    ),
  })
  .strict();

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function assertExactIdSet(
  requested: ScoreCandidate[],
  returned: ScoredCandidate[],
  context: ChatContext,
): void {
  const requestedIds = new Set(requested.map((candidate) => candidate.id));
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const item of returned) {
    if (seen.has(item.id)) duplicates.push(item.id);
    seen.add(item.id);
  }
  const missing = [...requestedIds].filter((id) => !seen.has(id));
  const extra = [...seen].filter((id) => !requestedIds.has(id));
  if (missing.length > 0 || extra.length > 0 || duplicates.length > 0) {
    throw new LlmError(
      'LLM_SCORE_SET_MISMATCH',
      `Relevance scoring returned the wrong id set (missing ${missing.length}, extra ${extra.length}, duplicates ${duplicates.length}).`,
      { ...context, missing, extra, duplicates },
    );
  }
}

/**
 * Scores candidates 0..10 against the topic in one or more validated calls.
 * The returned id set must match the requested set exactly.
 */
export async function scoreCandidates(llm: LlmClient, opts: ScoreOptions): Promise<ScoredCandidate[]> {
  if (opts.candidates.length === 0) return [];
  if (opts.batchSize < 1) {
    throw new LlmError('LLM_SCORE_SET_MISMATCH', 'relevance.batchSize must be at least 1.', {
      ...opts.context,
      batchSize: opts.batchSize,
    });
  }

  const results: ScoredCandidate[] = [];
  const batches = chunk(opts.candidates, opts.batchSize);
  for (const [index, batch] of batches.entries()) {
    const context: ChatContext = {
      stage: opts.context.stage,
      task: batches.length === 1 ? opts.context.task : `${opts.context.task}-${index + 1}`,
    };
    const payload = {
      topic: opts.topicKeywords,
      language: opts.language,
      candidates: batch.map((candidate) => ({
        id: candidate.id,
        author: candidate.author ?? null,
        text: candidate.text,
      })),
    };
    const parsed = await chatJson(
      llm,
      {
        messages: [
          {
            role: 'system',
            content:
              'You rank social media posts for editorial relevance. Reply with JSON only, matching {"scores":[{"id","score","reason"}]}. ' +
              'Score 0-10: 10 means directly about the topic and worth citing. Use every candidate id exactly once. ' +
              `Write reasons in ${opts.language}.`,
          },
          { role: 'user', content: JSON.stringify(payload) },
        ],
        maxTokens: opts.maxTokens,
        context,
      },
      scoresSchema,
      opts.sink,
    );
    assertExactIdSet(batch, parsed.scores, context);
    results.push(...parsed.scores);
  }
  return results;
}
