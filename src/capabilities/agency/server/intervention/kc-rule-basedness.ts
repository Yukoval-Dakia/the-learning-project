// Rule/procedure-vs-concept nature of one KC, for the pedagogy state guard.
//
// `knowledge` carries no rule/concept trait and no subject trait declares one, so the
// verdict comes from the two deterministic sources that do exist, most specific first:
//   1. the KC's own pool-visible questions — a majority of computation/derivation means
//      the KC is practiced by executing a rule or procedure;
//   2. the subject profile's declared question kinds, when they have a clear majority.
// A KC with neither signal — or with a tie — is 'unknown'; callers keep the conservative
// false value (withholding reconstruction) rather than letting a model invent this axis.

import { and, notInArray, sql } from 'drizzle-orm';
import { PROBE_QUESTION_SOURCE } from '@/core/schema/conjecture';
import { INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE } from '@/core/schema/intervention';
import type { Db, Tx } from '@/db/client';
import { notDraftPredicate } from '@/db/predicates';
import { question } from '@/db/schema';
import { resolveSubjectProfileForKnowledgeIdsStrict } from '@/kernel/read-models/subject-profile';
import { normalizeToCanonicalKind } from '@/subjects/question-kind';

type DbLike = Db | Tx;

export type KcRuleBasedness = 'rule_based' | 'concept_based' | 'unknown';

// Probe and intervention-diagnostic questions test one error signature; they describe an
// investigation, not how the KC is practiced, and must not steer its classification.
const NON_PRACTICE_QUESTION_SOURCES = [
  PROBE_QUESTION_SOURCE,
  INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE,
];

// `computation` (calculation / word_problem) and `derivation` (proof) are executed by a
// rule; prose kinds are recalled, translated, or explained instead.
const PROCEDURAL_CANONICAL_KINDS: ReadonlySet<string> = new Set(['computation', 'derivation']);
const PROCEDURAL_SUBJECT_KINDS: ReadonlySet<string> = new Set(['calculation', 'proof']);

// A single KC pool is small; the bound keeps the majority verdict cheap and stable.
const MAX_SAMPLE_QUESTIONS = 200;

// A tie is genuinely undecidable: half the evidence points each way, so neither the
// rule-based nor the concept-based pedagogy guard may claim it.
function majorityRuleBasedness(procedural: number, total: number): KcRuleBasedness {
  if (procedural * 2 > total) return 'rule_based';
  if (procedural * 2 < total) return 'concept_based';
  return 'unknown';
}

export async function getKcRuleBasedness(
  db: DbLike,
  knowledgeId: string,
): Promise<KcRuleBasedness> {
  const rows = await db
    .select({ kind: question.kind })
    .from(question)
    .where(
      and(
        sql`${question.knowledge_ids} @> ${JSON.stringify([knowledgeId])}::jsonb`,
        notDraftPredicate(question.draft_status),
        notInArray(question.source, NON_PRACTICE_QUESTION_SOURCES),
      ),
    )
    .limit(MAX_SAMPLE_QUESTIONS);
  if (rows.length > 0) {
    const procedural = rows.filter((row) =>
      PROCEDURAL_CANONICAL_KINDS.has(normalizeToCanonicalKind(row.kind) ?? row.kind),
    ).length;
    return majorityRuleBasedness(procedural, rows.length);
  }

  const profile = await resolveSubjectProfileForKnowledgeIdsStrict(db, [knowledgeId]).catch(
    () => null,
  );
  if (!profile) return 'unknown';
  // The profile is subject-wide, not per-KC: a declared procedural kind means the
  // subject practices rule-executed work at all, so an unclassified KC in it may be
  // reconstructed. A subject whose kinds are all prose kinds is concept-based.
  return profile.questionKinds.some((kind) => PROCEDURAL_SUBJECT_KINDS.has(kind))
    ? 'rule_based'
    : 'concept_based';
}
