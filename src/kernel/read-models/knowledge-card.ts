// Knowledge-point card by id: name, canonical judgment, band and last practice.
// Not the node page — no tree load, no neighbors, no raw ability readings on the wire.
//
// Visibility is existence + not archived + not learner-hidden. `knowledge` has no
// owner column in the single-tenant schema; re-review this read when tenancy lands.

import { and, eq, isNull } from 'drizzle-orm';

import { type MasteryBandIdx, masteryBandView } from '@/core/mastery-band';
import type { LearnerJudgment, LearnerJudgmentBatch } from '@/core/schema/learner-judgment';
import type { Db, Tx } from '@/db/client';
import { knowledge } from '@/db/schema';
import { type AnswerOutcome, loadLastKnowledgePractice } from './learner-activity';
import { readLearnerJudgments } from './learner-judgment';
import { isLearnerVisibleKnowledgeId } from './learner-knowledge-visibility';

type DbLike = Db | Tx;

export interface KnowledgeCardPractice {
  at: string;
  /** null when the answer has no usable verdict. */
  outcome: 'correct' | 'partial' | 'wrong' | null;
}

type KnowledgeCardJudgment = Pick<LearnerJudgment, 'ability_claim' | 'judgement'> & {
  uncertainty: Pick<LearnerJudgment['uncertainty'], 'evidence_age'>;
  batch: {
    calibration: LearnerJudgmentBatch['calibration'];
    as_of: string;
  };
};

export type KnowledgeEntityCard =
  | {
      entity_kind: 'knowledge';
      entity_id: string;
      state: 'ok';
      name: string;
      mastery_band: MasteryBandIdx | null;
      judgment: KnowledgeCardJudgment | null;
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

  const [batch, practice] = await Promise.all([
    readLearnerJudgments(db, { knowledge_ids: [id], context: 'any', as_of: new Date() }),
    loadLastKnowledgePractice(db, id),
  ]);
  const judgment = batch.items.find((item) => item.knowledge_id === id);
  const reading =
    judgment?.ability.kind === 'available' &&
    (judgment.ability_claim.kind === 'observed' || judgment.ability_claim.kind === 'low_observed')
      ? judgment.ability.reading
      : null;
  const band = reading ? masteryBandView(reading) : null;

  return {
    entity_kind: 'knowledge',
    entity_id: id,
    state: 'ok',
    name: node.name,
    mastery_band: band && !band.unknown ? band.band : null,
    judgment: judgment
      ? {
          ability_claim: judgment.ability_claim,
          uncertainty: { evidence_age: judgment.uncertainty.evidence_age },
          judgement: judgment.judgement,
          batch: { calibration: batch.calibration, as_of: batch.as_of.toISOString() },
        }
      : null,
    last_practice: practice ? { at: practice.at, outcome: cardOutcome(practice.outcome) } : null,
  };
}
