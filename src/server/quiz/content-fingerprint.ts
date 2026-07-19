import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { question } from '@/db/schema';

export const CANONICAL_QUESTION_CONTENT_VERSION = 1 as const;

export interface CanonicalQuestionContentInput {
  promptMd: string;
  referenceMd?: string | null;
  choicesMd?: string[] | null;
  rubricJson?: unknown;
  // Callers may carry provenance envelopes. Identity intentionally reads only the fields above.
  [key: string]: unknown;
}

function normalizeMarkdown(value: string): string {
  return (
    value
      .normalize('NFKC')
      .replace(/\r\n?/g, '\n')
      // Keep image presence + alt semantics while excluding unstable transport URLs.
      .replace(/!\[([^\]]*)\]\((?:\\.|[^)])*\)/g, (_match, alt: string) => {
        return `![${alt.trim()}](IMAGE)`;
      })
      // Canonicalize the two standard emphasis spellings without stripping Markdown semantics.
      .replace(/__([^_]+)__/g, '**$1**')
      .replace(/_([^_]+)_/g, '*$1*')
      .replace(/[\t\n\f\r ]+/g, ' ')
      .trim()
  );
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stableJson(child)]),
    );
  }
  return typeof value === 'string' ? normalizeMarkdown(value) : value;
}

export function canonicalQuestionContent(input: CanonicalQuestionContentInput): string {
  return JSON.stringify({
    version: CANONICAL_QUESTION_CONTENT_VERSION,
    prompt: normalizeMarkdown(input.promptMd),
    answer: input.referenceMd == null ? null : normalizeMarkdown(input.referenceMd),
    choices: input.choicesMd?.map(normalizeMarkdown) ?? null,
    rubric: input.rubricJson == null ? null : stableJson(input.rubricJson),
  });
}

/** Exact identity SHA-256. This is not the embedding freshness hash. */
export function canonicalQuestionContentHash(input: CanonicalQuestionContentInput): string {
  return createHash('sha256').update(canonicalQuestionContent(input)).digest('hex');
}

export interface ExactQuestionDuplicate {
  id: string;
  draftStatus: string | null;
  source: string;
}

/** Reusable active+draft lookup; legacy NULL-hash rows intentionally do not match. */
export async function findExactQuestionDuplicate(
  db: Db | Tx,
  hash: string,
): Promise<ExactQuestionDuplicate | null> {
  const rows = await db
    .select({ id: question.id, draftStatus: question.draft_status, source: question.source })
    .from(question)
    .where(eq(question.canonical_content_hash, hash))
    .limit(1);
  return rows[0] ?? null;
}
