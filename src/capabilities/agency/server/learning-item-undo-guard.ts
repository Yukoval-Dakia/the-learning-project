// Later-content rules for undoing an auto-applied `learning_item`.
//
// Agency owns the accept-path policy (only the existing-graph `3c` plan is batch
// undoable; `3a`/`3b` create knowledge nodes and stay human-reviewed) and the item
// lifecycle (archived state, later progress). The paired notes and their write
// history belong to notes; practice records and unsubmitted answer drafts belong
// to practice. Both answer through the composition root, so this file never reads
// another owner's rows.

import { eq, inArray } from 'drizzle-orm';
import type { ProposalNoteUndoFacts } from '@/capabilities/notes/public';
import type { AiProposalPayloadT } from '@/core/schema/proposal';
import type { Tx } from '@/db/client';
import { learning_item } from '@/db/schema';
import {
  AUTO_APPLIED_UNDO_CLEAR,
  type AutoAppliedUndoBlock,
  type AutoAppliedUndoGuardInput,
  type AutoAppliedUndoGuardVerdict,
  type AutoAppliedUndoOwnerGuard,
  type DbLike,
} from '@/kernel/proposals/auto-applied-undo';

/** Item ids (subset of the queried set) that still carry content owned elsewhere. */
export type LearningItemUsageProbe = (
  db: DbLike,
  itemIds: readonly string[],
) => Promise<ReadonlySet<string>>;

export interface LearningItemUndoDependencies {
  /** Live learning records attached to the item (practice/settlement). */
  readonly learningRecords: LearningItemUsageProbe;
  /** Item ids still holding an unsubmitted answer draft (practice/session). */
  readonly answerDrafts: LearningItemUsageProbe;
  readonly notes: {
    readonly readProposalNoteUndoFacts: (
      db: DbLike,
      input: { proposalIds: readonly string[]; primaryArtifactIds: readonly string[] },
    ) => Promise<ProposalNoteUndoFacts>;
    readonly lockProposalNoteArtifacts: (
      tx: Tx,
      input: { proposalId: string; primaryArtifactIds: readonly string[] },
    ) => Promise<void>;
  };
}

const REASONS = {
  plan_case_not_retractable: '这条学习路径会新建知识点，批量撤销暂时只支持已有图谱的情况。',
  learning_item_missing: '这批学习项已经找不到了。',
  learning_item_already_archived: '这些学习项已经被归档，不需要再撤销。',
  learning_item_partially_archived:
    '其中部分学习项已经被归档，撤销会对不上原来的计划，所以先保留了。',
  learning_item_later_changes: '这些学习项之后有了新的进展，撤销会丢掉进度，所以先保留了。',
  learning_item_has_records: '这些学习项已经产生练习记录，撤销会让记录失去关联，所以先保留了。',
  learning_item_artifact_missing: '这些学习项配对的笔记找不到了，撤销会对不上，所以先保留了。',
  learning_item_note_edited: '这些学习项的笔记之后被编辑过，撤销会覆盖这些修改，所以先保留了。',
  learning_item_artifact_referenced:
    '已经有别的笔记引用了这些学习项的笔记，撤销会让引用失效，所以先保留了。',
  learning_item_has_answer_drafts:
    '这些学习项还有未提交的作答草稿，撤销会打断正在写的答案，所以先保留了。',
} as const;

type LearningItemBlockCode = keyof typeof REASONS;

function block(code: LearningItemBlockCode): AutoAppliedUndoBlock {
  return { status: 'blocked', code, reason_md: REASONS[code] };
}

function readString(value: unknown, key: string): string | null {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  const field = record?.[key];
  return typeof field === 'string' && field.length > 0 ? field : null;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

interface LearningItemRow {
  readonly sourceRef: string | null;
  readonly id: string;
  readonly archivedAt: Date | null;
  readonly updatedAt: Date;
  readonly primaryArtifactId: string | null;
}

async function inspectLearningItems(
  db: DbLike,
  inputs: readonly AutoAppliedUndoGuardInput[],
  dependencies: LearningItemUndoDependencies,
): Promise<Map<string, AutoAppliedUndoGuardVerdict>> {
  const verdicts = new Map<string, AutoAppliedUndoGuardVerdict>();
  const proposalIds = inputs.map((input) => input.proposalId);
  if (proposalIds.length === 0) return verdicts;

  const rows = (await db
    .select({
      sourceRef: learning_item.source_ref,
      id: learning_item.id,
      archivedAt: learning_item.archived_at,
      updatedAt: learning_item.updated_at,
      primaryArtifactId: learning_item.primary_artifact_id,
    })
    .from(learning_item)
    .where(inArray(learning_item.source_ref, proposalIds))) as LearningItemRow[];
  const rowsByProposal = new Map<string, LearningItemRow[]>();
  for (const row of rows) {
    if (!row.sourceRef) continue;
    const list = rowsByProposal.get(row.sourceRef);
    if (list) list.push(row);
    else rowsByProposal.set(row.sourceRef, [row]);
  }

  const activeItemIds: string[] = [];
  const primaryArtifactIds: string[] = [];
  for (const proposalId of proposalIds) {
    for (const row of rowsByProposal.get(proposalId) ?? []) {
      if (row.archivedAt === null) activeItemIds.push(row.id);
      if (row.primaryArtifactId) primaryArtifactIds.push(row.primaryArtifactId);
    }
  }

  const [noteFacts, recordItemIds, draftItemIds] = await Promise.all([
    dependencies.notes.readProposalNoteUndoFacts(db, { proposalIds, primaryArtifactIds }),
    dependencies.learningRecords(db, activeItemIds),
    dependencies.answerDrafts(db, activeItemIds),
  ]);

  // References from notes in the SAME proposal are part of that proposal: retract
  // archives the whole note family together, so those refs disappear with it. Only
  // a note outside the group is later content that a retract would orphan.
  const pairedArtifactIdsByProposal = new Map<string, Set<string>>();
  for (const proposalId of proposalIds) {
    const group = new Set<string>(noteFacts.artifactIdsByProposal.get(proposalId) ?? []);
    for (const item of rowsByProposal.get(proposalId) ?? []) {
      if (item.primaryArtifactId) group.add(item.primaryArtifactId);
    }
    pairedArtifactIdsByProposal.set(proposalId, group);
  }

  const referencedArtifactIdsByProposal = new Map<string, Set<string>>();
  for (const proposalId of proposalIds) {
    const group = pairedArtifactIdsByProposal.get(proposalId) ?? new Set<string>();
    const referenced = new Set<string>();
    for (const artifactId of group) {
      for (const fromArtifactId of noteFacts.inboundRefsByTarget.get(artifactId) ?? []) {
        if (!group.has(fromArtifactId)) referenced.add(artifactId);
      }
    }
    referencedArtifactIdsByProposal.set(proposalId, referenced);
  }

  const inputById = new Map(inputs.map((input) => [input.proposalId, input]));
  for (const proposalId of proposalIds) {
    const input = inputById.get(proposalId);
    if (!input) continue;
    const items = rowsByProposal.get(proposalId) ?? [];
    const active = items.filter((item) => item.archivedAt === null);
    const archived = items.filter((item) => item.archivedAt !== null);
    if (items.length === 0) {
      verdicts.set(proposalId, block('learning_item_missing'));
      continue;
    }
    if (active.length === 0) {
      verdicts.set(proposalId, block('learning_item_already_archived'));
      continue;
    }
    if (archived.length > 0) {
      verdicts.set(proposalId, block('learning_item_partially_archived'));
      continue;
    }
    const latest = active.reduce(
      (max, item) => Math.max(max, asDate(item.updatedAt)?.getTime() ?? 0),
      0,
    );
    if (latest > input.appliedAt.getTime()) {
      verdicts.set(proposalId, block('learning_item_later_changes'));
      continue;
    }
    if (active.some((item) => recordItemIds.has(item.id))) {
      verdicts.set(proposalId, block('learning_item_has_records'));
      continue;
    }
    if (active.some((item) => draftItemIds.has(item.id))) {
      verdicts.set(proposalId, block('learning_item_has_answer_drafts'));
      continue;
    }
    const pairedArtifactIds = pairedArtifactIdsByProposal.get(proposalId) ?? new Set<string>();
    if (pairedArtifactIds.size === 0) {
      verdicts.set(proposalId, block('learning_item_artifact_missing'));
      continue;
    }
    const missingOrArchived = [...pairedArtifactIds].some((artifactId) => {
      const row = noteFacts.artifactById.get(artifactId);
      return !row || row.archivedAt !== null;
    });
    if (missingOrArchived) {
      verdicts.set(proposalId, block('learning_item_artifact_missing'));
      continue;
    }
    if ([...pairedArtifactIds].some((artifactId) => noteFacts.editedArtifactIds.has(artifactId))) {
      verdicts.set(proposalId, block('learning_item_note_edited'));
      continue;
    }
    if (
      [...pairedArtifactIds].some((artifactId) =>
        referencedArtifactIdsByProposal.get(proposalId)?.has(artifactId),
      )
    ) {
      verdicts.set(proposalId, block('learning_item_artifact_referenced'));
    }
    if (!verdicts.has(proposalId)) {
      verdicts.set(proposalId, AUTO_APPLIED_UNDO_CLEAR);
    }
  }
  return verdicts;
}

/** Only the existing-graph plan is retractable; the other plans mint a node. */
function eligibilityOf(payload: AiProposalPayloadT): AutoAppliedUndoBlock | null {
  if (payload.kind !== 'learning_item') return null;
  if (readString(payload.proposed_change, 'plan_case') === '3c_existing_graph') return null;
  return block('plan_case_not_retractable');
}

async function lockLearningItems(
  tx: Tx,
  input: AutoAppliedUndoGuardInput,
  dependencies: LearningItemUndoDependencies,
): Promise<void> {
  const items = await tx
    .select({ id: learning_item.id, primaryArtifactId: learning_item.primary_artifact_id })
    .from(learning_item)
    .where(eq(learning_item.source_ref, input.proposalId))
    .orderBy(learning_item.id)
    .for('update');
  const primaryArtifactIds = items
    .map((row) => row.primaryArtifactId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  await dependencies.notes.lockProposalNoteArtifacts(tx, {
    proposalId: input.proposalId,
    primaryArtifactIds,
  });
}

export function createLearningItemUndoGuard(
  dependencies: LearningItemUndoDependencies,
): AutoAppliedUndoOwnerGuard {
  return {
    eligible: eligibilityOf,
    inspect: (db, inputs) => inspectLearningItems(db, inputs, dependencies),
    lock: (tx, input) => lockLearningItems(tx, input, dependencies),
  };
}
