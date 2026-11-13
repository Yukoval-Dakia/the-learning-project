// Admitted solution priors name prerequisite knowledge, but that list never
// becomes a graph edge by itself. This read collects pairs where at least two
// live admitted questions agree on one dependent point, and resolves a name to
// an existing point only when that match is unique inside the dependent's
// subject. A question with more than one live point contributes nothing: a
// part lists prerequisites for that part, not for every point on the question.
// Questions whose live source policy no longer allows derivation are not
// counted. It does not write.

import { and, eq } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import {
  knowledge,
  question,
  question_group_lifecycle,
  question_solution_prior,
} from '@/db/schema';
import { batchResolveEffectiveDomains } from '@/kernel/read-models/knowledge-tree';
import { sourceAllowsDerivationSql } from '@/kernel/read-models/usage-policy';

/** A pair is a suggestion only once this many distinct questions name it. */
export const MIN_ADMITTED_PRIOR_PREREQUISITE_QUESTIONS = 2;

export interface PriorPrerequisiteMention {
  readonly knowledgeId: string | null;
  readonly name: string;
}

export interface AdmittedQuestionPrior {
  readonly questionId: string;
  readonly targetKnowledgeIds: readonly string[];
  readonly prerequisites: readonly PriorPrerequisiteMention[];
}

export interface LiveKnowledgePoint {
  readonly id: string;
  readonly name: string;
  readonly role: 'kc' | 'goal' | 'container';
  readonly archived: boolean;
  readonly effectiveDomain: string | null;
}

export interface PrerequisiteEdgeSupport {
  readonly fromKnowledgeId: string;
  readonly toKnowledgeId: string;
  readonly fromName: string;
  readonly toName: string;
  readonly questionIds: readonly string[];
}

interface PointIndex {
  readonly byId: ReadonlyMap<string, LiveKnowledgePoint>;
  readonly byDomainName: ReadonlyMap<string, readonly string[]>;
}

function domainNameKey(domain: string, name: string): string {
  return `${domain}\0${name}`;
}

function indexLivePoints(points: readonly LiveKnowledgePoint[]): PointIndex {
  const byId = new Map<string, LiveKnowledgePoint>();
  const grouped = new Map<string, string[]>();
  for (const point of points) {
    if (point.archived || point.role !== 'kc' || point.effectiveDomain == null) continue;
    byId.set(point.id, point);
    const key = domainNameKey(point.effectiveDomain, point.name);
    const ids = grouped.get(key) ?? [];
    ids.push(point.id);
    grouped.set(key, ids);
  }
  return { byId, byDomainName: grouped };
}

/**
 * Prefer the stored id when it is a live point in this subject. A stored id
 * that points at a live point in another subject is left unresolved: guessing
 * a same-named point would cross the claim the prior actually made. A missing
 * id falls back to one exact name in the dependent's subject.
 */
function resolvePrerequisite(
  mention: PriorPrerequisiteMention,
  domain: string,
  index: PointIndex,
): string | null {
  if (mention.knowledgeId != null) {
    const stored = index.byId.get(mention.knowledgeId);
    if (stored) return stored.effectiveDomain === domain ? stored.id : null;
  }
  const matches = index.byDomainName.get(domainNameKey(domain, mention.name)) ?? [];
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

/** Parts name prerequisites, not which tagged point they belong to. */
function soleDependent(
  targetKnowledgeIds: readonly string[],
  index: PointIndex,
): LiveKnowledgePoint | null {
  let sole: LiveKnowledgePoint | null = null;
  for (const targetId of targetKnowledgeIds) {
    const target = index.byId.get(targetId);
    if (target == null) continue;
    if (sole != null && sole.id !== target.id) return null;
    sole = target;
  }
  return sole;
}

export function prerequisiteEdgesFromAdmittedPriors(
  questions: readonly AdmittedQuestionPrior[],
  points: readonly LiveKnowledgePoint[],
  minQuestions = MIN_ADMITTED_PRIOR_PREREQUISITE_QUESTIONS,
): PrerequisiteEdgeSupport[] {
  const index = indexLivePoints(points);
  const support = new Map<string, { from: string; to: string; questions: Set<string> }>();
  for (const question of questions) {
    const target = soleDependent(question.targetKnowledgeIds, index);
    if (target?.effectiveDomain == null) continue;
    const seen = new Set<string>();
    for (const mention of question.prerequisites) {
      const fromId = resolvePrerequisite(mention, target.effectiveDomain, index);
      if (fromId == null || fromId === target.id) continue;
      const key = `${fromId}\0${target.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const bucket = support.get(key) ?? {
        from: fromId,
        to: target.id,
        questions: new Set<string>(),
      };
      bucket.questions.add(question.questionId);
      support.set(key, bucket);
    }
  }
  const edges: PrerequisiteEdgeSupport[] = [];
  for (const bucket of support.values()) {
    if (bucket.questions.size < minQuestions) continue;
    const from = index.byId.get(bucket.from);
    const to = index.byId.get(bucket.to);
    if (from == null || to == null) continue;
    edges.push({
      fromKnowledgeId: bucket.from,
      toKnowledgeId: bucket.to,
      fromName: from.name,
      toName: to.name,
      questionIds: [...bucket.questions].sort(),
    });
  }
  edges.sort(
    (a, b) =>
      a.fromKnowledgeId.localeCompare(b.fromKnowledgeId) ||
      a.toKnowledgeId.localeCompare(b.toKnowledgeId),
  );
  return edges;
}

function stringIds(value: readonly string[] | null): string[] {
  if (value == null) return [];
  return value.filter((id) => id.length > 0);
}

function parseMentions(prior: unknown): PriorPrerequisiteMention[] {
  if (prior == null || typeof prior !== 'object' || Array.isArray(prior)) return [];
  const list = (prior as { prerequisites?: unknown }).prerequisites;
  if (!Array.isArray(list)) return [];
  const mentions: PriorPrerequisiteMention[] = [];
  for (const item of list) {
    if (item == null || typeof item !== 'object' || Array.isArray(item)) continue;
    const name = (item as { name_md?: unknown }).name_md;
    const id = (item as { knowledge_id?: unknown }).knowledge_id;
    if (typeof name !== 'string' || name.trim().length === 0) continue;
    mentions.push({
      name: name.trim(),
      knowledgeId: typeof id === 'string' && id.trim().length > 0 ? id.trim() : null,
    });
  }
  return mentions;
}

/** Current revision only, and only questions still admitted and in service. */
export async function loadAdmittedPriorPrerequisiteEdges(
  db: Db | Tx,
): Promise<PrerequisiteEdgeSupport[]> {
  const [priorRows, pointRows] = await Promise.all([
    db
      .select({
        questionId: question_group_lifecycle.group_id,
        knowledgeIds: question.knowledge_ids,
        prior: question_solution_prior.prior,
      })
      .from(question_group_lifecycle)
      .innerJoin(question, eq(question.id, question_group_lifecycle.group_id))
      .innerJoin(
        question_solution_prior,
        eq(question_solution_prior.revision_id, question_group_lifecycle.current_revision_id),
      )
      .where(
        and(
          eq(question_group_lifecycle.scoring_admission_state, 'admitted'),
          eq(question_group_lifecycle.withdrawn, false),
          eq(question_group_lifecycle.suspended, false),
          eq(question_solution_prior.origin, 'admission'),
          // Admission freezes the prior; derivation consent is the live source policy.
          sourceAllowsDerivationSql({ kind: 'question', id: question.id }),
        ),
      ),
    db
      .select({
        id: knowledge.id,
        name: knowledge.name,
        role: knowledge.role,
        archived_at: knowledge.archived_at,
      })
      .from(knowledge),
  ]);
  const domains = await batchResolveEffectiveDomains(
    db,
    pointRows.map((row) => row.id),
  );
  const byQuestion = new Map<
    string,
    {
      questionId: string;
      targetKnowledgeIds: string[];
      prerequisites: PriorPrerequisiteMention[];
    }
  >();
  for (const row of priorRows) {
    const current = byQuestion.get(row.questionId) ?? {
      questionId: row.questionId,
      targetKnowledgeIds: stringIds(row.knowledgeIds),
      prerequisites: [],
    };
    current.prerequisites.push(...parseMentions(row.prior));
    byQuestion.set(row.questionId, current);
  }
  const points: LiveKnowledgePoint[] = pointRows.map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role,
    archived: row.archived_at != null,
    effectiveDomain: domains.get(row.id) ?? null,
  }));
  return prerequisiteEdgesFromAdmittedPriors([...byQuestion.values()], points);
}
