// YUK-1508 (Stage「第一天能用」T3) — deterministic fallback body when note
// generation fails (provider error, timeout, or output-parse failure — the
// YUK-981 class). The learner must never be left with a blank note or a bare
// error: the body is filled from REAL, already-persisted material only — the
// note's own title, an excerpt of its first source material, the related
// knowledge-point names, and (when the note was generated from an
// already-issued question) the question's frozen reference solution under the
// SAME reveal rules as the YUK-1409 hint fallback. Every piece is labelled
// with where it came from and the body opens with
// 「自动生成失败，以下为原材料整理」. No AI content is invented.
//
// Reveal rules (mirror buildSolveHintFallback in practice/server/solve-session.ts;
// notes cannot import practice — the capability-boundary baseline pins
// notes->practice at 0 value edges): the frozen sol_* reference is included
// ONLY when the issuance's solution was already revealed through the dedicated
// reveal path (a prior experimental:assessment_assistance kind='solution'
// exposure event) — re-serving an already-revealed reference is
// non-disclosing, and the serving is recorded as one more kind='solution' /
// impact='answer_help' exposure so submission snapshots keep counting it.
// Without prior exposure the reference is withheld and the body says so
// honestly, mirroring the hint ladder's disclosure line.
//
// The question linkage is EXPLICIT data on the note row (attrs
// source_issuance_id + source_question_id, stamped by whatever writer derives
// a note from an issued question — e.g. a future from_mistake writer). It is
// never inferred from knowledge-node overlap: inferring would leak a frozen
// reference into a note the question never fed.

import { createId } from '@paralleldrive/cuid2';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { canonicalHash } from '@/core/migration/canonical';
import type { ArtifactBodyBlocksT } from '@/core/schema/business';
import { INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE } from '@/core/schema/intervention';
import type { Db, Tx } from '@/db/client';
import {
  artifact,
  assessment_issuance,
  event,
  knowledge,
  question,
  question_revision,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';

import { loadNoteGenerationReferences } from './note-generation-references';

/** Attrs key stamped on the marker block of every fallback body. */
export const NOTE_GENERATION_FALLBACK_MARKER = 'note_generation_fallback';
/** Current fallback body shape version (bump when the layout changes). */
export const NOTE_GENERATION_FALLBACK_MARKER_VALUE = 'v1';
/** actor_ref for the fallback's body_blocks_edit event. */
export const NOTE_GENERATION_FALLBACK_ACTOR_REF = 'note_generate_fallback';

export const NOTE_GENERATION_FALLBACK_NOTICE =
  '自动生成失败，以下为原材料整理（非 AI 生成，各段已标注来源）。';

/** Mirrors the sol_* asset-id shape filter in projectFrozenStudyContext. */
const FROZEN_SOLUTION_ASSET_RE = /^sol_[0-9a-f]{12}$/;

const MATERIAL_EXCERPT_MAX_CHARS = 400;

export interface NoteGenerationFallbackQuestion {
  question_id: string;
  issuance_id: string;
  /** Live question prompt (same source the hint fallback reads). */
  prompt_excerpt: string;
  /** Frozen sol_* solution material; non-null only under the reveal rules. */
  reference_md: string | null;
  /** A frozen reference exists but was not yet revealed — withheld honestly. */
  reference_withheld: boolean;
}

export interface NoteGenerationFallbackMaterial {
  artifactId: string;
  title: string;
  intent: string | null;
  parentHub: { title: string; summary_md: string } | null;
  referenceNote: { title: string; excerpt: string } | null;
  knowledgePoints: { id: string; name: string }[];
  question: NoteGenerationFallbackQuestion | null;
}

function capExcerpt(value: string, maxChars = MATERIAL_EXCERPT_MAX_CHARS): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars - 1)}…` : collapsed;
}

/** Mirror of hasPriorSolutionExposure (solve-session.ts) — the reveal rule. */
async function hasPriorSolutionExposure(db: Db, issuanceId: string): Promise<boolean> {
  const rows = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:assessment_assistance'),
        eq(event.subject_id, issuanceId),
        sql`${event.payload}->>'kind' = 'solution'`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Frozen sol_* solution material scoped to the ISSUED parts only — mirrors the
 * scoping + asset filter of projectFrozenStudyContext (study-context.ts) so a
 * multi-part revision never leaks a non-issued part's solution. Walked with
 * runtime guards over the raw jsonb structure (no projection duplication).
 */
function extractFrozenSolutionMd(structure: unknown, partIds: readonly string[]): string | null {
  if (structure === null || typeof structure !== 'object') return null;
  const record = structure as Record<string, unknown>;
  const issuedParts = new Set(partIds);
  const scopedMaterialIds = new Set<string>();
  if (Array.isArray(record.parts)) {
    for (const part of record.parts) {
      if (part === null || typeof part !== 'object') continue;
      const p = part as Record<string, unknown>;
      if (typeof p.part_id !== 'string' || !issuedParts.has(p.part_id)) continue;
      if (Array.isArray(p.material_ids)) {
        for (const id of p.material_ids) if (typeof id === 'string') scopedMaterialIds.add(id);
      }
    }
  }
  if (!Array.isArray(record.materials)) return null;
  const texts: string[] = [];
  for (const material of record.materials) {
    if (material === null || typeof material !== 'object') continue;
    const m = material as Record<string, unknown>;
    if (typeof m.material_id !== 'string' || !scopedMaterialIds.has(m.material_id)) continue;
    const asset = m.asset as Record<string, unknown> | null | undefined;
    const assetId = asset != null && typeof asset === 'object' ? asset.asset_id : undefined;
    if (typeof assetId !== 'string' || !FROZEN_SOLUTION_ASSET_RE.test(assetId)) continue;
    if (typeof m.content_md === 'string' && m.content_md.length > 0) texts.push(m.content_md);
  }
  return texts.length > 0 ? texts.join('\n\n') : null;
}

/**
 * Question branch — only for notes whose attrs carry an EXPLICIT
 * source_issuance_id + source_question_id linkage (no writer today; a future
 * question→note writer stamps them). Coordinate + reveal-unavailable checks
 * mirror loadFrozenStudyContext (study-context.ts); a mismatch or a
 * non-assistable issuance simply leaves the question branch off.
 */
async function loadFallbackQuestion(
  db: Db,
  attrs: unknown,
): Promise<NoteGenerationFallbackQuestion | null> {
  const record =
    attrs !== null && typeof attrs === 'object' ? (attrs as Record<string, unknown>) : {};
  const issuanceId =
    typeof record.source_issuance_id === 'string' ? record.source_issuance_id : null;
  const questionId =
    typeof record.source_question_id === 'string' ? record.source_question_id : null;
  if (!issuanceId || !questionId) return null;

  const [issuance] = await db
    .select()
    .from(assessment_issuance)
    .where(eq(assessment_issuance.issuance_id, issuanceId))
    .limit(1);
  if (!issuance) return null;
  const [revision] = await db
    .select({ group_id: question_revision.group_id, structure: question_revision.structure })
    .from(question_revision)
    .where(eq(question_revision.revision_id, issuance.revision_id))
    .limit(1);
  if (!revision || (revision.group_id !== questionId && !issuance.part_ids.includes(questionId)))
    return null;
  const [q] = await db
    .select({ prompt_md: question.prompt_md, source: question.source })
    .from(question)
    .where(eq(question.id, questionId))
    .limit(1);
  if (!q) return null;

  // reveal_unavailable mirrors loadFrozenStudyContext: intervention
  // diagnostics and container occurrences never permit study assistance.
  const assistable =
    q.source !== INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE && !issuance.container_occurrence_ref;
  const solutionMd = assistable
    ? extractFrozenSolutionMd(revision.structure, issuance.part_ids)
    : null;
  const revealed = solutionMd !== null && (await hasPriorSolutionExposure(db, issuanceId));

  return {
    question_id: questionId,
    issuance_id: issuanceId,
    prompt_excerpt: capExcerpt(q.prompt_md),
    reference_md: revealed ? solutionMd : null,
    reference_withheld: solutionMd !== null && !revealed,
  };
}

/**
 * Load every piece of real fallback material for a note. Reads only frozen or
 * display-grade data (knowledge names, hub summary, sibling note excerpts, the
 * frozen issuance); nothing here calls a model or invents content.
 */
export async function loadNoteGenerationFallbackMaterial(
  db: Db,
  note: {
    id: string;
    title: string;
    knowledge_ids: string[];
    parent_artifact_id: string | null;
    attrs: unknown;
  },
): Promise<NoteGenerationFallbackMaterial> {
  const attrsRecord =
    note.attrs !== null && typeof note.attrs === 'object'
      ? (note.attrs as Record<string, unknown>)
      : {};
  const intent =
    typeof attrsRecord.one_line_intent === 'string' ? attrsRecord.one_line_intent : null;

  let parentHub: { title: string; summary_md: string } | null = null;
  if (note.parent_artifact_id) {
    const [parent] = await db
      .select({ title: artifact.title, attrs: artifact.attrs })
      .from(artifact)
      .where(eq(artifact.id, note.parent_artifact_id))
      .limit(1);
    if (parent) {
      const parentAttrs =
        parent.attrs !== null && typeof parent.attrs === 'object'
          ? (parent.attrs as Record<string, unknown>)
          : {};
      const summaryMd =
        typeof parentAttrs.summary_md === 'string' && parentAttrs.summary_md.trim().length > 0
          ? parentAttrs.summary_md
          : null;
      if (summaryMd) parentHub = { title: parent.title, summary_md: summaryMd };
    }
  }

  // First sibling-family note with real text — same loader the generation
  // prompt uses, so「首份来源材料」matches what the model itself would see.
  let referenceNote: { title: string; excerpt: string } | null = null;
  const references = await loadNoteGenerationReferences(db, {
    id: note.id,
    parent_artifact_id: note.parent_artifact_id,
    knowledge_ids: note.knowledge_ids,
  });
  for (const ref of references) {
    const excerpt = capExcerpt(
      ref.blocks
        .map((block) => block.text_excerpt)
        .filter((text) => text.trim().length > 0)
        .slice(0, 3)
        .join(' '),
    );
    if (excerpt) {
      referenceNote = { title: ref.title, excerpt };
      break;
    }
  }

  let knowledgePoints: { id: string; name: string }[] = [];
  if (note.knowledge_ids.length > 0) {
    const kRows = await db
      .select({ id: knowledge.id, name: knowledge.name })
      .from(knowledge)
      .where(inArray(knowledge.id, note.knowledge_ids));
    const byId = new Map(kRows.map((row) => [row.id, row]));
    knowledgePoints = note.knowledge_ids
      .map((id) => byId.get(id))
      .filter((row): row is { id: string; name: string } => row !== undefined);
  }

  return {
    artifactId: note.id,
    title: note.title,
    intent,
    parentHub,
    referenceNote,
    knowledgePoints,
    question: await loadFallbackQuestion(db, note.attrs),
  };
}

function fallbackParagraph(text: string, marker = false): Record<string, unknown> {
  return {
    type: 'paragraph',
    attrs: {
      id: `nfb_${createId()}`,
      source_markdown: text,
      ...(marker
        ? { [NOTE_GENERATION_FALLBACK_MARKER]: NOTE_GENERATION_FALLBACK_MARKER_VALUE }
        : {}),
    },
    content: text.length > 0 ? [{ type: 'text', text }] : [],
  };
}

/**
 * Build the deterministic fallback body_blocks. Pure function of the material:
 * title + first-source excerpt + knowledge points (+ gated frozen reference),
 * each labelled with its origin, under the honest failure notice.
 */
export function buildNoteGenerationFallbackBody(
  material: NoteGenerationFallbackMaterial,
): ArtifactBodyBlocksT {
  const paragraphs: Record<string, unknown>[] = [
    fallbackParagraph(NOTE_GENERATION_FALLBACK_NOTICE, true),
    fallbackParagraph(`标题：${material.title}（来源：本笔记标题）`),
  ];

  if (material.question) {
    paragraphs.push(
      fallbackParagraph(
        `材料摘录（来源：已发题目 ${material.question.question_id} 的题面）：${material.question.prompt_excerpt}`,
      ),
    );
    if (material.question.reference_md) {
      paragraphs.push(
        fallbackParagraph(
          `题目封存参考解（来源：该题封存参考材料，此前已经过「查看完整解」展示；非本次 AI 生成；查看参考解记为非独立完成）：${material.question.reference_md}`,
        ),
      );
    } else if (material.question.reference_withheld) {
      paragraphs.push(
        fallbackParagraph(
          '该题有封存参考解——按揭示规则未在此展开；可在题目页走「查看完整解」（记为非独立完成）后重新生成。',
        ),
      );
    }
  } else if (material.referenceNote) {
    paragraphs.push(
      fallbackParagraph(
        `材料摘录（来源：关联笔记《${material.referenceNote.title}》）：${material.referenceNote.excerpt}`,
      ),
    );
  } else if (material.parentHub) {
    paragraphs.push(
      fallbackParagraph(
        `材料摘录（来源：父笔记《${material.parentHub.title}》主题摘要）：${capExcerpt(material.parentHub.summary_md)}`,
      ),
    );
  } else if (material.intent) {
    paragraphs.push(
      fallbackParagraph(`材料摘录（来源：本笔记的学习意图）：${capExcerpt(material.intent)}`),
    );
  }

  if (material.knowledgePoints.length > 0) {
    paragraphs.push(
      fallbackParagraph(
        `相关知识点（来源：知识图谱）：${material.knowledgePoints.map((kp) => kp.name).join('、')}`,
      ),
    );
  }

  return { type: 'doc', content: paragraphs } as ArtifactBodyBlocksT;
}

/** True when the body carries no top-level blocks (null or empty content). */
export function noteBodyIsEmpty(body: unknown): boolean {
  if (body === null || typeof body !== 'object') return true;
  const content = (body as Record<string, unknown>).content;
  return !Array.isArray(content) || content.length === 0;
}

/** True when the body already IS a fallback body (the marker block is present). */
export function isNoteGenerationFallbackBody(body: unknown): boolean {
  if (body === null || typeof body !== 'object') return false;
  const content = (body as Record<string, unknown>).content;
  if (!Array.isArray(content)) return false;
  for (const node of content) {
    if (node === null || typeof node !== 'object') continue;
    const attrs = (node as Record<string, unknown>).attrs;
    if (
      attrs !== null &&
      typeof attrs === 'object' &&
      (attrs as Record<string, unknown>)[NOTE_GENERATION_FALLBACK_MARKER] ===
        NOTE_GENERATION_FALLBACK_MARKER_VALUE
    )
      return true;
  }
  return false;
}

/**
 * True when the body is the UNTOUCHED fallback: the marker block is present AND
 * the last history entry is the fallback write itself at the current version.
 * A learner edit (or any later body write) pushes a newer history entry, so this
 * flips false the moment anyone touches the fallback — those edits must never
 * be clobbered by a retry's success body.
 */
export function isUntouchedNoteGenerationFallbackBody(
  body: unknown,
  history: unknown,
  version: number,
): boolean {
  if (!isNoteGenerationFallbackBody(body)) return false;
  const entries = Array.isArray(history) ? history : [];
  const last = entries.length > 0 ? entries[entries.length - 1] : null;
  if (last === null || typeof last !== 'object') return false;
  const entry = last as Record<string, unknown>;
  return entry.action === 'note_generation_fallback' && entry.next_artifact_version === version;
}

/**
 * May a generation success body (or a retry reopen) take over this note? Only
 * when the body is still empty, or it is exactly the untouched fallback.
 * Anything else is human/agent-authored content the generation must not clobber.
 */
export function mayOverwriteNoteBodyForGeneration(
  body: unknown,
  history: unknown,
  version: number,
): boolean {
  return noteBodyIsEmpty(body) || isUntouchedNoteGenerationFallbackBody(body, history, version);
}

/**
 * Record the fallback's serving of an already-revealed frozen reference —
 * SAME event action/payload shape as recordAssistanceExposure
 * (practice/server/assessment/assistance.ts) so exposure accounting and
 * submission snapshots count it identically; actor_ref names the real writer.
 */
export async function recordNoteFallbackReferenceExposure(
  tx: Tx,
  input: { issuanceId: string; referenceMd: string },
): Promise<void> {
  await writeEvent(tx, {
    id: `evt_help_${createId()}`,
    actor_kind: 'system',
    actor_ref: NOTE_GENERATION_FALLBACK_ACTOR_REF,
    action: 'experimental:assessment_assistance',
    subject_kind: 'issuance',
    subject_id: input.issuanceId,
    outcome: null,
    payload: {
      version: 1,
      kind: 'solution',
      impact: 'answer_help',
      content_digest: `sha256:${canonicalHash(input.referenceMd)}`,
    },
  });
}
