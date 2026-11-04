// One-off backfill of the solution prior for questions admitted before it existed. The
// prior call sends question text to a provider, so a group qualifies only if the same
// content already went through a paid admission solve: no new outward scope.

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import {
  ai_task_runs,
  event,
  knowledge,
  question,
  question_admission_verification,
  question_group_lifecycle,
  question_revision,
  question_solution_prior,
} from '@/db/schema';
import { readEventDerivationPolicy } from '@/kernel/events/derivation-policy';
import {
  publishedContractSeal,
  publishedSealAccepts,
} from '@/kernel/records/assessment-normalization';
import { type BoundRunTaskTextFn, makeRunTaskTextFn } from '@/server/ai/runner-fn';
import { resolveSubjectProfile } from '@/subjects/profile';
import { definitionFromContract } from './definition-from-contract';
import { loadPriorKnowledgeCandidates } from './solution-prior';
import { runSolutionPriorPass, settledKeysFromDefinition } from './solve';

export type BackfillExclusion =
  | 'no_current_revision'
  | 'not_admitted'
  | 'withdrawn'
  | 'suspended'
  | 'no_paid_admission_evidence'
  | 'vision_source'
  | 'quiz_gen_material_unproven'
  | 'already_has_prior';

export interface BackfillGroupFacts {
  group_id: string;
  revision_id: string | null;
  admission_state: string;
  withdrawn: boolean;
  suspended: boolean;
  source: string | null;
  /** A passed admission on this revision and digest, with paid solve runs on record. */
  has_paid_admission_evidence: boolean;
  source_ref_is_knowledge: boolean;
  part_count: number;
  prior_rows: number;
}

/**
 * The eligibility rule. `question.source` is a mutable column, so it can only exclude,
 * never admit: the proof is the immutable admission evidence. The derivation policy is
 * read separately because it needs each publication's event lineage.
 */
export function backfillExclusion(facts: BackfillGroupFacts): BackfillExclusion | null {
  if (facts.revision_id == null) return 'no_current_revision';
  if (facts.admission_state !== 'admitted') return 'not_admitted';
  if (facts.withdrawn) return 'withdrawn';
  if (facts.suspended) return 'suspended';
  if (!facts.has_paid_admission_evidence) return 'no_paid_admission_evidence';
  if (facts.source?.startsWith('vision_')) return 'vision_source';
  if (facts.source === 'quiz_gen' && !facts.source_ref_is_knowledge) {
    return 'quiz_gen_material_unproven';
  }
  if (facts.part_count > 0 && facts.prior_rows >= facts.part_count) return 'already_has_prior';
  return null;
}

export interface BackfillCensus {
  total_groups: number;
  eligible: { group_id: string; revision_id: string }[];
  excluded: Partial<Record<BackfillExclusion | 'derivation_policy_not_allow', string[]>>;
}

export async function censusSolutionPriorBackfill(db: Db): Promise<BackfillCensus> {
  const rows = await db.execute<BackfillGroupFacts & Record<string, unknown>>(sql`
    SELECT l.group_id, l.current_revision_id AS revision_id,
           l.scoring_admission_state AS admission_state, l.withdrawn, l.suspended, q.source,
           EXISTS (
             SELECT 1 FROM ${question_admission_verification} v
             WHERE v.revision_id = l.current_revision_id
               AND v.revision_digest = r.integrity_digest
               AND v.outcome = 'passed'
               AND v.evidence->>'pack' = 'question_admission'
               AND jsonb_array_length(COALESCE(v.evidence->'task_runs', '[]'::jsonb)) > 0
           ) AS has_paid_admission_evidence,
           EXISTS (
             SELECT 1 FROM ${knowledge} k WHERE k.id = q.source_ref
           ) AS source_ref_is_knowledge,
           COALESCE(jsonb_array_length(r.structure->'parts'), 0)::int AS part_count,
           (SELECT count(*)::int FROM ${question_solution_prior} p
            WHERE p.revision_id = l.current_revision_id) AS prior_rows
    FROM ${question_group_lifecycle} l
    LEFT JOIN ${question} q ON q.id = l.group_id
    LEFT JOIN ${question_revision} r ON r.revision_id = l.current_revision_id
    ORDER BY l.group_id
  `);
  const census: BackfillCensus = { total_groups: 0, eligible: [], excluded: {} };
  const exclude = (reason: keyof BackfillCensus['excluded'], groupId: string) => {
    census.excluded[reason] = [...(census.excluded[reason] ?? []), groupId];
  };
  for (const facts of rows) {
    census.total_groups += 1;
    const reason = backfillExclusion(facts);
    if (reason != null) {
      exclude(reason, facts.group_id);
      continue;
    }
    // A further condition, not proof: the reader answers `allow` when it finds no restriction.
    const publications = await db
      .select({ id: event.id })
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:assessment_publish'),
          eq(event.subject_kind, 'question'),
          eq(event.subject_id, facts.group_id),
        ),
      );
    const policies = await Promise.all(
      publications.map((row) => readEventDerivationPolicy(db, row.id)),
    );
    if (policies.some((policy) => policy !== 'allow')) {
      exclude('derivation_policy_not_allow', facts.group_id);
      continue;
    }
    census.eligible.push({ group_id: facts.group_id, revision_id: facts.revision_id as string });
  }
  return census;
}

export interface BackfillResult {
  group_id: string;
  revision_id: string;
  status: 'produced' | 'empty' | 'failed' | 'skipped';
  task_run_id: string | null;
  parts_written: number;
  reason?: string;
}

async function subjectProfileForGroup(db: Db, groupId: string) {
  const [row] = await db
    .select({ knowledge_ids: question.knowledge_ids })
    .from(question)
    .where(eq(question.id, groupId))
    .limit(1);
  const first = row?.knowledge_ids?.[0];
  const [node] = first
    ? await db
        .select({ domain: knowledge.domain })
        .from(knowledge)
        .where(eq(knowledge.id, first))
        .limit(1)
    : [undefined];
  return resolveSubjectProfile(node?.domain ?? null);
}

/** The stored revision as admission grades it; null when its seal no longer verifies. */
function sealedDefinition(revision: typeof question_revision.$inferSelect) {
  try {
    const seal = publishedContractSeal({
      structure: revision.structure,
      response_spec: revision.response_spec,
      scoring_basis: revision.scoring_basis,
      execution_plan: revision.execution_plan,
      ...(revision.presentation != null ? { presentation: revision.presentation } : {}),
    });
    if (!publishedSealAccepts(seal, revision.integrity_digest)) return null;
    return definitionFromContract({
      ...seal.parsed,
      integrity_digest: revision.integrity_digest,
      group_id: revision.group_id,
      conversion_issues: [],
    });
  } catch {
    return null;
  }
}

/**
 * Describe up to `limit` eligible groups, one at a time. Writes only prior rows: no
 * revision, admission state or difficulty anchor changes, so a revert is a plain delete.
 */
export async function applySolutionPriorBackfill(
  db: Db,
  input: { backfillRunId: string; limit: number; runTask?: BoundRunTaskTextFn },
): Promise<{ results: BackfillResult[]; cost_usd: number; unknown_cost_runs: number }> {
  const runTask = input.runTask ?? makeRunTaskTextFn(db, { judgeRetryPolicy: 'none' });
  const census = await censusSolutionPriorBackfill(db);
  const results: BackfillResult[] = [];
  for (const { group_id, revision_id } of census.eligible.slice(0, input.limit)) {
    const skipped = (reason: string): BackfillResult => ({
      group_id,
      revision_id,
      status: 'skipped',
      task_run_id: null,
      parts_written: 0,
      reason,
    });
    const [revision] = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, revision_id))
      .limit(1);
    const definition = revision ? sealedDefinition(revision) : null;
    if (definition == null) {
      results.push(skipped('revision seal does not verify'));
      continue;
    }
    const keys = settledKeysFromDefinition(definition);
    if (keys.size === 0) {
      results.push(skipped('no settled key'));
      continue;
    }
    const subjectProfile = await subjectProfileForGroup(db, group_id);
    const knowledgeCandidates = await loadPriorKnowledgeCandidates(db, {
      groupId: group_id,
      subjectId: subjectProfile.id,
    });
    const pass = await runSolutionPriorPass(db, definition, keys, {
      runTask,
      subjectProfile,
      knowledgeCandidates,
    });
    const record = pass.record;
    const written =
      record == null
        ? []
        : await db
            .insert(question_solution_prior)
            .values(
              record.parts.map((part) => ({
                revision_id,
                part_id: part.part_id,
                prior_version: record.prior_version,
                prior: part as unknown as Record<string, unknown>,
                origin: 'backfill' as const,
                task_run_ids: record.task_run_ids,
                backfill_run_id: input.backfillRunId,
                created_at: new Date(),
              })),
            )
            .onConflictDoNothing()
            .returning({ part_id: question_solution_prior.part_id });
    results.push({
      group_id,
      revision_id,
      status: pass.outcome.status,
      task_run_id: pass.outcome.task_run_id ?? null,
      parts_written: written.length,
      ...(pass.outcome.reason != null ? { reason: pass.outcome.reason } : {}),
    });
  }
  const runIds = results.flatMap((r) => (r.task_run_id != null ? [r.task_run_id] : []));
  const costs =
    runIds.length > 0
      ? await db
          .select({ cost_usd: ai_task_runs.cost_usd })
          .from(ai_task_runs)
          .where(inArray(ai_task_runs.id, runIds))
      : [];
  return {
    results,
    cost_usd: costs.reduce((sum, row) => sum + Number(row.cost_usd ?? 0), 0),
    unknown_cost_runs: runIds.length - costs.filter((row) => row.cost_usd != null).length,
  };
}

/** Undo one run: its prior rows, and their vectors by cascade. Lists only unless `apply`. */
export async function revertSolutionPriorBackfill(
  db: Db,
  input: { backfillRunId: string; apply: boolean },
): Promise<{ revision_id: string; part_id: string }[]> {
  const where = eq(question_solution_prior.backfill_run_id, input.backfillRunId);
  const columns = {
    revision_id: question_solution_prior.revision_id,
    part_id: question_solution_prior.part_id,
  };
  return input.apply
    ? db.delete(question_solution_prior).where(where).returning(columns)
    : db.select(columns).from(question_solution_prior).where(where);
}
