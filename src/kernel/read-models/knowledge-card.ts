// Knowledge-point card by id: name, mastery band, last practice. Not the node page —
// no tree load, no neighbors, no evidence counts on the wire.
//
// Visibility is existence + not archived + not learner-hidden. `knowledge` has no
// owner column in the single-tenant schema; re-review this read when tenancy lands.

import { and, eq, isNull } from 'drizzle-orm';

import { type MasteryBandIdx, masteryBandIdx } from '@/core/mastery-band';
import type { Db, Tx } from '@/db/client';
import { knowledge } from '@/db/schema';
import { type AnswerOutcome, loadLastKnowledgePractice } from './learner-activity';
import { isLearnerVisibleKnowledgeId } from './learner-knowledge-visibility';
import { getMasteryProjection } from './mastery-projection';

type DbLike = Db | Tx;

export interface KnowledgeCardPractice {
  at: string;
  /** null when the answer has no usable verdict. */
  outcome: 'correct' | 'partial' | 'wrong' | null;
}

export type KnowledgeEntityCard =
  | {
      entity_kind: 'knowledge';
      entity_id: string;
      state: 'ok';
      name: string;
      mastery_band: MasteryBandIdx | null;
      last_practice: KnowledgeCardPractice | null;
    }
  | { entity_kind: 'knowledge'; entity_id: string; state: 'gone' };

function cardOutcome(outcome: AnswerOutcome | null): KnowledgeCardPractice['outcome'] {
  if (outcome === 'success') return 'correct';
  if (outcome === 'failure') return 'wrong';
  return outcome;
}

export async function isKnowledgeCardVisible(db: DbLike, id: string): Promise<boolean> {
  return (await loadKnowledgeCardNode(db, id)) !== null;
}

async function loadKnowledgeCardNode(db: DbLike, id: string) {
  if (!isLearnerVisibleKnowledgeId(id)) return null;
  const rows = await db
    .select({ id: knowledge.id, name: knowledge.name })
    .from(knowledge)
    .where(and(eq(knowledge.id, id), isNull(knowledge.archived_at)))
    .limit(1);
  return rows[0] ?? null;
}

export async function readKnowledgeEntityCard(
  db: DbLike,
  id: string,
): Promise<KnowledgeEntityCard> {
  const node = await loadKnowledgeCardNode(db, id);
  if (!node) return { entity_kind: 'knowledge', entity_id: id, state: 'gone' };

  const [projection, practice] = await Promise.all([
    getMasteryProjection(db, [id]),
    loadLastKnowledgePractice(db, id),
  ]);
  const reading = projection.get(id);
  // Cold start projects a point estimate but no evidence: that is unknown, not 萌芽.
  const masteryBand =
    reading && reading.evidence_count > 0 ? masteryBandIdx(reading.mastery) : null;

  return {
    entity_kind: 'knowledge',
    entity_id: id,
    state: 'ok',
    name: node.name,
    mastery_band: masteryBand,
    last_practice: practice ? { at: practice.at, outcome: cardOutcome(practice.outcome) } : null,
  };
}
