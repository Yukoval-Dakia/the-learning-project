// Shared NoteGenerateTask input assembly for one note artifact: parent hub,
// knowledge nodes, one-line intent, bounded reference artifacts, and a bounded
// learner slice for those knowledge points. Consumers: the note_generate job
// and the long-note check revision round (YUK-1642).
import { eq, inArray } from 'drizzle-orm';

import type { NoteGenerationReference } from '@/capabilities/notes/server/note-generation-references';
import { loadNoteGenerationReferences } from '@/capabilities/notes/server/note-generation-references';
import { learnerLocalDay } from '@/core/learner-day';
import { A5_BANDS, masteryBandIdx } from '@/core/mastery-band';
import { learnerDayWithWeekday } from '@/core/steering';
import type { Db } from '@/db/client';
import { artifact, knowledge } from '@/db/schema';
import { effectiveCauseCategoryForFailureAttempt } from '@/kernel/read-models/cause-policy';
import { getFailureAttemptsForDerivation } from '@/kernel/read-models/failure-attempts';
import { getMasteryProjection } from '@/kernel/read-models/mastery-projection';
import { resolveMiscCauseLabels } from '@/kernel/read-models/misc-cause-labels';
import { resolveSubjectProfile } from '@/subjects/profile';

export interface NoteGenerateSourceRow {
  id: string;
  type: string;
  title: string;
  knowledge_ids: string[];
  parent_artifact_id: string | null;
  attrs: unknown;
}

/** One wrong answer already narrowed to the note's knowledge points. Newest first. */
export interface NoteLearnerAnswerFact {
  answer_md: string | null;
  cause_category: string | null;
}

/**
 * Mastery band, at most two causes or misconceptions, and at most two recent
 * wrong answers. Present only when at least one cause or wrong answer remains.
 */
export interface NoteLearnerSlice {
  mastery_band: (typeof A5_BANDS)[number] | null;
  causes: Array<{ label: string }>;
  recent_wrong_answers: Array<{ answer_md: string }>;
}

export interface NoteLearnerSliceFacts {
  answers: readonly NoteLearnerAnswerFact[];
  mastery: { evidence_count: number; mastery: number } | null;
  /** Category id to a profile label or a misconception title. */
  labels: ReadonlyMap<string, string>;
  /** Category ids whose label is authored text and must stay delimited. */
  untrustedLabels: ReadonlySet<string>;
}

/** Same cap other learner-text packets use before a model sees them. */
const NOTE_LEARNER_ANSWER_CHAR_CAP = 2000;
const NOTE_LEARNER_CAUSE_LABEL_CHAR_CAP = 80;
const NOTE_LEARNER_CAUSE_LIMIT = 2;
const NOTE_LEARNER_ANSWER_LIMIT = 2;
/**
 * Newest derivation-allowed failures considered. Same window as the
 * knowledge-node cause read: older mistakes on this point stay out once 200
 * newer allowed failures exist anywhere.
 */
const NOTE_LEARNER_FAILURE_WINDOW = 200;

const UNTRUSTED_OPEN = '<untrusted_learner_text>';
const UNTRUSTED_CLOSE = '</untrusted_learner_text>';
const EMBEDDED_DELIMITER = /<(\/?)(untrusted_learner_text)>/gi;

function boundLearnerText(text: string, max: number): string {
  const sliced = text.length > max ? text.slice(0, max) : text;
  return `${UNTRUSTED_OPEN}${sliced.replace(EMBEDDED_DELIMITER, '&lt;$1$2&gt;')}${UNTRUSTED_CLOSE}`;
}

/** Rank, cap, and drop an empty slice. Caller already applied the derivation filter. */
export function assembleNoteLearnerSlice(facts: NoteLearnerSliceFacts): NoteLearnerSlice | null {
  const counts = new Map<string, number>();
  for (const row of facts.answers) {
    if (!row.cause_category) continue;
    counts.set(row.cause_category, (counts.get(row.cause_category) ?? 0) + 1);
  }
  const causes = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, NOTE_LEARNER_CAUSE_LIMIT)
    .map(([category]) => {
      const label = facts.labels.get(category) ?? category;
      return {
        label: facts.untrustedLabels.has(category)
          ? boundLearnerText(label, NOTE_LEARNER_CAUSE_LABEL_CHAR_CAP)
          : label,
      };
    });
  const recentWrongAnswers = facts.answers
    .flatMap((row) => {
      const text = row.answer_md?.trim();
      return text ? [{ answer_md: boundLearnerText(text, NOTE_LEARNER_ANSWER_CHAR_CAP) }] : [];
    })
    .slice(0, NOTE_LEARNER_ANSWER_LIMIT);
  if (causes.length === 0 && recentWrongAnswers.length === 0) return null;
  const mastery = facts.mastery;
  const masteryBand =
    mastery && mastery.evidence_count > 0 && Number.isFinite(mastery.mastery)
      ? A5_BANDS[masteryBandIdx(mastery.mastery)]
      : null;
  return {
    mastery_band: masteryBand,
    causes,
    recent_wrong_answers: recentWrongAnswers,
  };
}

async function loadNoteLearnerSlice(
  db: Db,
  knowledgeIds: readonly string[],
  domain: string | null,
): Promise<NoteLearnerSlice | null> {
  const primaryId = knowledgeIds[0];
  if (!primaryId) return null;
  const wanted = new Set(knowledgeIds);
  const [failures, projection] = await Promise.all([
    getFailureAttemptsForDerivation(db, { limit: NOTE_LEARNER_FAILURE_WINDOW }),
    getMasteryProjection(db, [primaryId]),
  ]);
  const matched = failures.filter((failure) =>
    failure.referenced_knowledge_ids.some((id) => wanted.has(id)),
  );
  const categories = [
    ...new Set(
      matched.flatMap((failure) => {
        const category = effectiveCauseCategoryForFailureAttempt(failure);
        return category ? [category] : [];
      }),
    ),
  ];
  const profileLabels = new Map(
    resolveSubjectProfile(domain).causeCategories.map((category) => [category.id, category.label]),
  );
  const misconceptionTitles = await resolveMiscCauseLabels(db, categories);
  const labels = new Map<string, string>();
  const untrustedLabels = new Set<string>();
  for (const category of categories) {
    const title = misconceptionTitles.get(category)?.trim();
    if (title) {
      labels.set(category, title);
      untrustedLabels.add(category);
      continue;
    }
    const profileLabel = profileLabels.get(category);
    if (profileLabel) labels.set(category, profileLabel);
  }
  const reading = projection.get(primaryId);
  return assembleNoteLearnerSlice({
    answers: matched.map((failure) => ({
      answer_md: failure.answer_md,
      cause_category: effectiveCauseCategoryForFailureAttempt(failure),
    })),
    mastery: reading ? { evidence_count: reading.evidence_count, mastery: reading.mastery } : null,
    labels,
    untrustedLabels,
  });
}

export interface NoteGenerateTaskInput {
  artifact_id: string;
  artifact_type: string;
  atomic_title: string;
  title: string;
  /** YUK-1770 — learner-local today 'YYYY-MM-DD（周X）'; anchors relative dates. */
  today: string;
  one_line_intent: string | null;
  knowledge_node: { id: string; name: string; domain: string | null } | null;
  knowledge_nodes: Array<{ id: string; name: string; domain: string | null }>;
  parent_hub: { title: string; summary_md: string | null } | null;
  related_knowledge_ids: string[];
  reference_artifacts: NoteGenerationReference[];
  /**
   * Omitted when this knowledge point has no quotable cause or wrong answer.
   * Restricted purposes never reach this field.
   */
  learner_slice?: NoteLearnerSlice;
}

export async function loadNoteGenerateTaskInput(
  db: Db,
  row: NoteGenerateSourceRow,
  now: Date = new Date(),
): Promise<{ input: NoteGenerateTaskInput; referenceArtifacts: NoteGenerationReference[] }> {
  let parentHub: { title: string; attrs: unknown } | null = null;
  if (row.parent_artifact_id) {
    const parentRows = await db
      .select({
        title: artifact.title,
        attrs: artifact.attrs,
      })
      .from(artifact)
      .where(eq(artifact.id, row.parent_artifact_id))
      .limit(1);
    parentHub = parentRows[0] ?? null;
  }

  let kNode: { id: string; name: string; domain: string | null } | null = null;
  let kNodes: Array<{ id: string; name: string; domain: string | null }> = [];
  if (row.knowledge_ids.length > 0) {
    const kRows = await db
      .select({ id: knowledge.id, name: knowledge.name, domain: knowledge.domain })
      .from(knowledge)
      .where(inArray(knowledge.id, row.knowledge_ids));
    const byId = new Map(kRows.map((node) => [node.id, node]));
    kNodes = row.knowledge_ids.map((id) => byId.get(id)).filter((node) => node !== undefined);
    kNode = kNodes[0] ?? null;
  }

  const oneLine = (row.attrs as { one_line_intent?: string } | null)?.one_line_intent ?? null;
  const parentSummary = (parentHub?.attrs as { summary_md?: string } | null)?.summary_md ?? null;
  const referenceArtifacts = await loadNoteGenerationReferences(db, row);
  const learnerSlice = await loadNoteLearnerSlice(db, row.knowledge_ids, kNode?.domain ?? null);

  const input: NoteGenerateTaskInput = {
    artifact_id: row.id,
    artifact_type: row.type,
    atomic_title: row.title,
    title: row.title,
    today: learnerDayWithWeekday(learnerLocalDay(now)),
    one_line_intent: oneLine,
    knowledge_node: kNode,
    knowledge_nodes: kNodes,
    parent_hub: parentHub ? { title: parentHub.title, summary_md: parentSummary } : null,
    related_knowledge_ids: row.knowledge_ids.slice(1),
    reference_artifacts: referenceArtifacts,
    ...(learnerSlice ? { learner_slice: learnerSlice } : {}),
  };
  return { input, referenceArtifacts };
}
