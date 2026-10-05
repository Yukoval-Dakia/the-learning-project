import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { knowledge, misconception, misconception_edge } from '@/db/schema';
import { getEffectiveDomain } from '@/kernel/read-models/knowledge-tree';

export interface FailureLearningKnowledgeNode {
  id: string;
  name: string;
  effective_domain: string | null;
}

/**
 * Capability-owned bounded read for Failure Learning.
 *
 * The old attribution adapter loaded the complete knowledge tree and filtered it
 * in memory. This query reads only the active ids named by the attempt, then
 * resolves at most each requested node's 32-level ancestor chain. Output order
 * follows the caller's first occurrence so profile selection is deterministic.
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
        // Preserve the former tool adapter's fallback for a broken ancestor:
        // the node's own domain is still a useful lower-bound subject signal.
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

// Defensive row cap on the caused_by join — a single attempt references a small KC
// set and the promote writer is flag-gated, so this is degenerate-defense, not a
// business cap (mirrors CONFIRMED_CAP in misconception-read.ts).
const MISCONCEPTION_FEED_CAP = 50;

/**
 * YUK-1015 (454-A) — bounded read of promoted misconception nodes for the
 * attribution retrieve stage. Design §L1: retrieve candidates = vocab ∪ 已晋升
 * 误区节点. Returns active (non-archived) misconceptions with a live `caused_by`
 * edge to ANY of the attempt's KCs, deduplicated across KCs, most-recurrent
 * first. Honest-empty day-one (promote flag off → []), never zero-filled.
 *
 * SOFT-TRACK ONLY: feeds LLM candidate lists — never θ̂/p(L)/FSRS.
 */
export async function listActiveMisconceptionsForKcs(
  db: Db | Tx,
  knowledgeIds: readonly string[],
): Promise<FailureLearningMisconceptionNode[]> {
  const kcIds = [...new Set(knowledgeIds.map((id) => id.trim()).filter(Boolean))];
  if (kcIds.length === 0) return [];

  return db
    .selectDistinct({
      id: misconception.id,
      title: misconception.title,
      reasoning: misconception.reasoning,
      seen: misconception.seen,
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

/**
 * YUK-1015 (454-A) — by-id companion to {@link listActiveMisconceptionsForKcs}.
 * Resolves stored `misc_` cause ids back to their node (title/reasoning) so
 * downstream consumers (variant-gen targetability + cause display) read the
 * node instead of the opaque hash. Active-only on purpose: a draft/archived —
 * i.e. retracted — node resolves to nothing, and callers treat that as "no
 * semantics to act on" (variant-gen skips, displays fall back).
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
