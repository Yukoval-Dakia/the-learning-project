// Solution-method prior: HOW a part is solved — methods with key steps, specific error
// mechanisms, prerequisite knowledge and a difficulty prior, written by one pass after the
// keys are settled. It is metadata, never an admission gate: a missing or malformed prior
// only means the part has no prior. Frozen per (revision, part).
//
// The prior carries the solution path, so it is private like the reference answer.
// Server-side consumers read it here; no learner-facing path may expose it before the
// learner's verdict is visible.

import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { knowledge, question, question_solution_prior } from '@/db/schema';
import { applyItemPrior } from '@/kernel/records/item-calibration';

export const SOLUTION_PRIOR_VERSION = 'solution-prior-v1';

const MAX_METHODS = 4;
const MAX_PITFALLS = 6;
const MAX_PREREQUISITES = 6;
const MAX_KNOWLEDGE_CANDIDATES = 200;

const Text = (max: number) => z.string().trim().min(1).max(max);

const PriorMethod = z.object({
  core_idea_md: Text(200),
  key_step_md: Text(200),
  steps_md: z.array(Text(160)).max(6).default([]),
});
const PriorPitfall = z.object({
  mechanism_md: Text(300),
  trigger_md: Text(160),
  method_idx: z.number().int().min(0).optional(),
});
const PriorPrerequisite = z.object({
  name_md: Text(80),
  knowledge_id: z.string().min(1).nullable(),
});
// Same ±6 barrier as ItemPriorDraft: an extreme b would poison θ̂ updates.
const PriorDifficulty = z.object({
  b_logit: z.number().min(-6).max(6),
  sd_logit: z.number().positive().max(6),
  basis_md: z.string().trim().max(200).default(''),
});

export const SolutionPriorPart = z.strictObject({
  part_id: z.string().min(1),
  methods: z.array(PriorMethod.strict()).min(1).max(MAX_METHODS),
  pitfalls: z.array(PriorPitfall.strict()).max(MAX_PITFALLS),
  prerequisites: z.array(PriorPrerequisite.strict()).max(MAX_PREREQUISITES),
  difficulty: PriorDifficulty.strict().nullable(),
});
export type SolutionPriorPartT = z.infer<typeof SolutionPriorPart>;

/** What admission hands to publication (inside the durable paid receipt). */
export const SolutionPriorRecord = z.strictObject({
  prior_version: z.literal(SOLUTION_PRIOR_VERSION),
  parts: z.array(SolutionPriorPart).min(1),
  task_run_ids: z.array(z.string().min(1)).min(1),
});
export type SolutionPriorRecordT = z.infer<typeof SolutionPriorRecord>;

export interface KnowledgeCandidate {
  knowledge_id: string;
  name: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function salvageList<T>(raw: unknown, schema: z.ZodType<T>, max: number): T[] {
  if (!Array.isArray(raw)) return [];
  const out: T[] = [];
  for (const item of raw) {
    const parsed = schema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * The model's `prior` → validated parts. Invalid items are dropped one by one
 * (an over-long pitfall loses that pitfall, not the part); a part survives only with
 * at least one valid method. Knowledge ids outside the offered candidates become null.
 */
export function salvageSolverPrior(
  raw: unknown,
  partIds: readonly string[],
  candidateIds: ReadonlySet<string>,
): SolutionPriorPartT[] {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set(partIds);
  const seen = new Set<string>();
  const parts: SolutionPriorPartT[] = [];
  for (const entry of raw) {
    const row = record(entry);
    const partId = typeof row?.part_id === 'string' ? row.part_id : null;
    if (row == null || partId == null || !allowed.has(partId) || seen.has(partId)) continue;
    const methods: SolutionPriorPartT['methods'] = [];
    // A pitfall's method_idx points into the solver's list, which may lose items here.
    const methodAt = new Map<number, number>();
    (Array.isArray(row.methods) ? row.methods : []).forEach((raw, index) => {
      const parsed = PriorMethod.safeParse(raw);
      if (!parsed.success || methods.length >= MAX_METHODS) return;
      methodAt.set(index, methods.push(parsed.data) - 1);
    });
    if (methods.length === 0) continue;
    seen.add(partId);
    const pitfalls = salvageList(row.pitfalls, PriorPitfall, MAX_PITFALLS).map((p) => {
      const idx = p.method_idx != null ? methodAt.get(p.method_idx) : undefined;
      return {
        mechanism_md: p.mechanism_md,
        trigger_md: p.trigger_md,
        ...(idx != null ? { method_idx: idx } : {}),
      };
    });
    const prerequisites = salvageList(
      Array.isArray(row.prerequisites)
        ? row.prerequisites.map((p) => {
            const r = record(p);
            return r == null ? p : { ...r, knowledge_id: r.knowledge_id || null };
          })
        : row.prerequisites,
      PriorPrerequisite,
      MAX_PREREQUISITES,
    ).map((p) =>
      p.knowledge_id != null && !candidateIds.has(p.knowledge_id)
        ? { ...p, knowledge_id: null }
        : p,
    );
    const difficulty = PriorDifficulty.safeParse(row.difficulty);
    parts.push({
      part_id: partId,
      methods,
      pitfalls,
      prerequisites,
      difficulty: difficulty.success ? difficulty.data : null,
    });
  }
  return parts;
}

/** One solver's raw prior → the record publication stores; null if nothing usable. */
export function buildSolutionPriorRecord(input: {
  raw: unknown;
  partIds: readonly string[];
  candidates: readonly KnowledgeCandidate[];
  taskRunId: string;
}): SolutionPriorRecordT | null {
  const ids = new Set(input.candidates.map((c) => c.knowledge_id));
  const parts = salvageSolverPrior(input.raw, input.partIds, ids);
  if (parts.length === 0) return null;
  return { prior_version: SOLUTION_PRIOR_VERSION, parts, task_run_ids: [input.taskRunId] };
}

/**
 * Live knowledge points offered to the solvers: the question's own points first, then
 * the rest of its subject (plus subject-less points), capped. Names and ids only.
 */
export async function loadPriorKnowledgeCandidates(
  db: Db,
  input: { groupId: string; subjectId: string },
): Promise<KnowledgeCandidate[]> {
  const [root] = await db
    .select({ knowledge_ids: question.knowledge_ids })
    .from(question)
    .where(eq(question.id, input.groupId))
    .limit(1);
  const own = root?.knowledge_ids ?? [];
  const rows = await db
    .select({ knowledge_id: knowledge.id, name: knowledge.name })
    .from(knowledge)
    .where(
      and(
        isNull(knowledge.archived_at),
        eq(knowledge.role, 'kc'),
        eq(knowledge.approval_status, 'approved'),
        or(
          eq(knowledge.domain, input.subjectId),
          isNull(knowledge.domain),
          own.length > 0 ? inArray(knowledge.id, own) : sql`false`,
        ),
      ),
    )
    .orderBy(asc(knowledge.name), asc(knowledge.id));
  const ownSet = new Set(own);
  return [
    ...rows.filter((r) => ownSet.has(r.knowledge_id)),
    ...rows.filter((r) => !ownSet.has(r.knowledge_id)),
  ].slice(0, MAX_KNOWLEDGE_CANDIDATES);
}

// ItemPriorDraft.confidence is provenance only (ADR-0043 sets τ by source, never by
// self-reported confidence), so this mapping does not change the posterior.
const confidenceFromSd = (sd: number) => Math.min(0.95, Math.max(0.05, 1 - sd / 2.5));

/**
 * Freeze the prior on the just-published revision (write-once per part) and, when the
 * question has no difficulty anchor yet, seed it through the single cold-start writer.
 * Runs inside the admission publication transaction.
 */
export async function recordAdmissionSolutionPrior(
  tx: Tx,
  input: { revisionId: string; questionId: string; record: SolutionPriorRecordT; now: Date },
): Promise<{ parts_written: number }> {
  const rows = input.record.parts.map((part) => ({
    revision_id: input.revisionId,
    part_id: part.part_id,
    prior_version: input.record.prior_version,
    prior: part as unknown as Record<string, unknown>,
    origin: 'admission' as const,
    task_run_ids: input.record.task_run_ids,
    created_at: input.now,
  }));
  const written = await tx
    .insert(question_solution_prior)
    .values(rows)
    .onConflictDoNothing()
    .returning({ part_id: question_solution_prior.part_id });
  const difficulties = input.record.parts
    .map((part) => part.difficulty)
    .filter((d): d is NonNullable<typeof d> => d != null);
  if (difficulties.length > 0) {
    const n = difficulties.length;
    const b = difficulties.reduce((sum, d) => sum + d.b_logit, 0) / n;
    const sd = Math.sqrt(difficulties.reduce((sum, d) => sum + d.sd_logit ** 2, 0) / n);
    await applyItemPrior(tx, {
      questionId: input.questionId,
      draft: {
        b_logit: b,
        confidence: confidenceFromSd(sd),
        reasoning: `admission solution prior (${SOLUTION_PRIOR_VERSION}): ${difficulties
          .map((d) => d.basis_md)
          .filter(Boolean)
          .join(' / ')}`.slice(0, 1000),
      },
    });
  }
  return { parts_written: written.length };
}

export interface StoredSolutionPrior {
  revision_id: string;
  part_id: string;
  prior_version: string;
  prior: SolutionPriorPartT;
  origin: 'admission' | 'backfill';
  task_run_ids: string[];
}

/**
 * Server-only read (grading, Backtrace writer, selection, signals). Must never be
 * wrapped as a learner-facing tool: the prior reveals the solution path.
 */
export async function readSolutionPriorForServer(
  db: Db | Tx,
  input: { revisionId: string; partId?: string },
): Promise<StoredSolutionPrior[]> {
  const rows = await db
    .select()
    .from(question_solution_prior)
    .where(
      input.partId != null
        ? and(
            eq(question_solution_prior.revision_id, input.revisionId),
            eq(question_solution_prior.part_id, input.partId),
          )
        : eq(question_solution_prior.revision_id, input.revisionId),
    )
    .orderBy(asc(question_solution_prior.part_id));
  const out: StoredSolutionPrior[] = [];
  for (const row of rows) {
    const prior = SolutionPriorPart.safeParse(row.prior);
    if (!prior.success) continue;
    out.push({
      revision_id: row.revision_id,
      part_id: row.part_id,
      prior_version: row.prior_version,
      prior: prior.data,
      origin: row.origin,
      task_run_ids: row.task_run_ids,
    });
  }
  return out;
}
