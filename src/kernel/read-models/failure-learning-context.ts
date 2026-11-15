import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { knowledge, misconception, misconception_edge } from '@/db/schema';
import { getEffectiveDomain } from '@/kernel/read-models/knowledge-tree';
import { readCompletionSources } from '@/kernel/read-models/usage-policy';

export interface FailureLearningKnowledgeNode {
  id: string;
  name: string;
  effective_domain: string | null;
}

/**
 * Bounded read for Failure Learning: only the active ids named by the attempt and
 * their ancestor chains. Output follows the caller's order so profile choice is stable.
 */
export async function loadFailureLearningKnowledgeContext(
  db: Db | Tx,
  knowledgeIds: readonly string[],
): Promise<FailureLearningKnowledgeNode[]> {
  const requested = [...new Set(knowledgeIds.map((id) => id.trim()).filter(Boolean))];
  if (requested.length === 0) return [];

  const rows = await db
    .select({ id: knowledge.id, name: knowledge.name, domain: knowledge.domain })
    .from(knowledge)
    .where(and(inArray(knowledge.id, requested), isNull(knowledge.archived_at)));
  const byId = new Map(rows.map((row) => [row.id, row]));

  const resolved = await Promise.all(
    requested.map(async (id): Promise<FailureLearningKnowledgeNode | null> => {
      const row = byId.get(id);
      if (!row) return null;
      let effectiveDomain: string | null = null;
      try {
        effectiveDomain = await getEffectiveDomain(db, id);
      } catch {
        // A broken ancestor still leaves the node's own domain as a useful signal.
        effectiveDomain = row.domain;
      }
      return { id: row.id, name: row.name, effective_domain: effectiveDomain };
    }),
  );
  return resolved.filter((node): node is FailureLearningKnowledgeNode => node !== null);
}

export interface FailureLearningMisconceptionNode {
  id: string;
  title: string;
  reasoning: string | null;
  seen: number;
}

// Defensive cap; a single attempt references only a small KC set.
const MISCONCEPTION_FEED_CAP = 50;

/**
 * Active misconceptions linked by a live caused_by edge to any of these KCs,
 * deduplicated and most recurrent first. Empty while promotion is off, never
 * zero-filled. Soft track only: feeds candidate lists, never mastery or FSRS.
 */
export async function listActiveMisconceptionsForKcs(
  db: Db | Tx,
  knowledgeIds: readonly string[],
): Promise<FailureLearningMisconceptionNode[]> {
  const rows = await readActiveMisconceptionsForKcs(db, knowledgeIds);
  return rows.map(({ id, title, reasoning, seen }) => ({ id, title, reasoning, seen }));
}

async function readActiveMisconceptionsForKcs(db: Db | Tx, knowledgeIds: readonly string[]) {
  const kcIds = [...new Set(knowledgeIds.map((id) => id.trim()).filter(Boolean))];
  if (kcIds.length === 0) return [];

  return db
    .selectDistinct({
      id: misconception.id,
      title: misconception.title,
      reasoning: misconception.reasoning,
      seen: misconception.seen,
      source: misconception.source,
      evidence: misconception.evidence,
    })
    .from(misconception_edge)
    .innerJoin(misconception, eq(misconception.id, misconception_edge.from_id))
    .where(
      and(
        eq(misconception_edge.relation_type, 'caused_by'),
        eq(misconception_edge.from_kind, 'misconception'),
        eq(misconception_edge.to_kind, 'knowledge'),
        inArray(misconception_edge.to_id, kcIds),
        isNull(misconception_edge.archived_at),
        eq(misconception.status, 'active'),
        isNull(misconception.archived_at),
      ),
    )
    .orderBy(desc(misconception.seen), desc(misconception.id))
    .limit(MISCONCEPTION_FEED_CAP);
}

/** Model-input projection; shares the evidence/consent boundary with weak-point derivation. */
export async function listDerivableActiveMisconceptionsForKcs(
  db: Db | Tx,
  knowledgeIds: readonly string[],
): Promise<FailureLearningMisconceptionNode[]> {
  const rows = await listDerivableMisconceptionEvidenceForKcs(db, knowledgeIds);
  return rows.map(({ id, title, reasoning, seen }) => ({ id, title, reasoning, seen }));
}

/** Active status is not reuse authority; all evidence must pass, never just a safe subset. */
export async function listDerivableMisconceptionEvidenceForKcs(
  db: Db | Tx,
  knowledgeIds: readonly string[],
) {
  const candidates = await readActiveMisconceptionsForKcs(db, knowledgeIds);
  const safe = [];
  for (const row of candidates) {
    if (
      !['soft', 'hard'].includes(row.source) ||
      !Array.isArray(row.evidence) ||
      row.evidence.length === 0 ||
      row.evidence.length > 200 ||
      row.evidence.some((id) => typeof id !== 'string' || id.trim().length === 0)
    )
      continue;
    const sources = await readCompletionSources(
      db,
      [...new Set(row.evidence)].map((id) => ({ kind: 'event' as const, id })),
    );
    // Promotion stores event pointers, not frozen document epochs. Do not reconstruct
    // a title's past consent from today's document policy; those rows stay withheld.
    if (sources === null || sources.nodes.some((node) => node.kind === 'document')) continue;
    safe.push(row);
  }
  return safe;
}

/**
 * Resolve stored misconception ids to their nodes. Active only, so a retracted node
 * resolves to nothing and callers skip it.
 */
export async function getMisconceptionsByIds(
  db: Db | Tx,
  ids: readonly string[],
): Promise<FailureLearningMisconceptionNode[]> {
  const wanted = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (wanted.length === 0) return [];

  return db
    .select({
      id: misconception.id,
      title: misconception.title,
      reasoning: misconception.reasoning,
      seen: misconception.seen,
    })
    .from(misconception)
    .where(
      and(
        inArray(misconception.id, wanted),
        eq(misconception.status, 'active'),
        isNull(misconception.archived_at),
      ),
    )
    .orderBy(desc(misconception.seen), desc(misconception.id))
    .limit(MISCONCEPTION_FEED_CAP);
}
