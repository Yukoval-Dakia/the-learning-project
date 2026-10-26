// Single owner for agent-callable question structure edits.
//
// Edits target the pre-import draft question_block tree and figures; non-draft blocks
// are a soft skip rather than a throw. Every write stamps agent_edit provenance, bumps
// the version under SELECT ... FOR UPDATE, and writes both the SSE job event and the
// canonical edit event. Callers surface soft skip results; unexpected faults throw.

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';

import { newId } from '@/core/ids';
import { encodeDraftRef } from '@/core/question-draft-ref';
import {
  type PresentationT,
  declaredShapeSupport,
  validatePresentation,
  validateResponseSpec,
  validateStructure,
} from '@/core/schema/assessment';
import type { QuestionKind } from '@/core/schema/business';
import {
  DRAFT_DOCUMENT_SCHEMA_VERSION,
  type QuestionBlockStructuredT,
  QuestionDraftDocument,
  isLegacyStructuredQuestion,
} from '@/core/schema/question-draft';
import type { FigureRefT, StructuredQuestionT } from '@/core/schema/structured_question';
import { structuredToPromptMarkdown } from '@/core/schema/structured_question';
import type { Db, Tx } from '@/db/client';
import { event, question_block, source_asset } from '@/db/schema';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import { writeEvent } from '@/kernel/events';
import { writeJobEvent } from '@/kernel/job-events';
import type { NormalizableQuestionRow } from '@/kernel/records/assessment-normalization';
import { normalizeQuestionRowToContract } from '@/kernel/records/assessment-normalization';
import { writeQuestionBlockLifecycleEvent } from '@/kernel/records/question-block-lifecycle-event';
import { hasQuestionBlockGenesisAnchor } from '@/server/projections/parity';
import { projectQuestionBlockGuarded } from '@/server/projections/question_block';
import { draftDocumentToContract } from '@/server/questions/draft-contract';
import { capturedQuestionShape } from './captured-question-shape';

// ---------------------------------------------------------------------------
// Shared tree helpers
// ---------------------------------------------------------------------------

/** True if `target` matches the id of `node` or any descendant. */
export function idHasMatch(node: StructuredQuestionT, target: string): boolean {
  if (node.id === target) return true;
  for (const sub of node.sub_questions ?? []) {
    if (idHasMatch(sub, target)) return true;
  }
  return false;
}

/**
 * Applies `mutate` to a cloned node whose id matches `target`. Mutating the clone keeps
 * callers from aliasing the persisted jsonb.
 */
function mapNodeById(
  node: StructuredQuestionT,
  target: string,
  mutate: (n: StructuredQuestionT) => void,
): { tree: StructuredQuestionT; matched: boolean } {
  const clone: StructuredQuestionT = {
    ...node,
    sub_questions: node.sub_questions ? node.sub_questions.map((s) => ({ ...s })) : undefined,
  };
  if (clone.id === target) {
    mutate(clone);
    return { tree: clone, matched: true };
  }
  let matched = false;
  if (clone.sub_questions) {
    clone.sub_questions = clone.sub_questions.map((sub) => {
      const res = mapNodeById(sub, target, mutate);
      if (res.matched) matched = true;
      return res.tree;
    });
  }
  return { tree: clone, matched };
}

/** Stamp agent-edit provenance onto a node (mutates in place). */
function stampProvenance(node: StructuredQuestionT, actorRef: string): void {
  node.source = 'agent_edit';
  node.last_modified_by = actorRef;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type EditStatus =
  | 'written'
  | 'skipped:not_draft'
  | 'skipped:node_not_found'
  | 'skipped:not_splittable'
  | 'skipped:cross_session'
  | 'skipped:block_not_found'
  | 'skipped:figure_not_found'
  | 'skipped:null_structured';

export interface EditResult {
  status: EditStatus;
  /** Set on `written`; the post-mutation version of the primary block. */
  version?: number;
}

export interface BaseEditParams {
  /** `callerActor.ref` of the tool caller, stamped as `last_modified_by`. */
  actorRef: string;
  /**
   * Provenance for the canonical edit event. Agent tools default to 'agent'; the
   * user-driven proposal accept path passes 'user'. The fold does not read it.
   */
  actorKind?: 'agent' | 'user';
}

// Single-block ops; merge_questions is multi-row and handled inline. The canonical
// event's op enum gates fold cardinality.
type SingleBlockEditOp =
  | 'update_prompt'
  | 'add_option'
  | 'set_question_type'
  | 'split_stem'
  // The AFTER tree carries the presentation, so the fold reproduces it; a raw update
  // would be erased on rebuild.
  | 'set_presentation';

// ---------------------------------------------------------------------------
// Internal: load a draft block FOR UPDATE inside a tx
// ---------------------------------------------------------------------------

export type BlockRow = typeof question_block.$inferSelect;

async function loadBlockForUpdate(tx: Tx, blockId: string): Promise<BlockRow | undefined> {
  const rows = await tx
    .select()
    .from(question_block)
    .where(eq(question_block.id, blockId))
    .for('update');
  return rows[0];
}

interface PersistStructuredParams {
  blockId: string;
  /** The AFTER tree; single-block edits always rewrite it. */
  structured: QuestionBlockStructuredT;
  op: SingleBlockEditOp;
  /** Orthogonal SSE transport payload. */
  jobPayload: Record<string, unknown>;
  actorRef: string;
  actorKind: 'agent' | 'user';
  /**
   * The block's unchanged status. persistStructured never writes status, so the snapshot
   * must carry it or the fold diverges from the row.
   */
  currentStatus: string;
  /**
   * The current version read under the row lock. The next version is this + 1, shared
   * by the canonical event and the projection write-through.
   */
  currentVersion: number;
  /** Only when this op also re-points figures; otherwise the snapshot omits them and
   *  the fold falls back to row.figures. */
  figures?: FigureRefT[];
}

async function persistStructured(tx: Tx, params: PersistStructuredParams): Promise<number> {
  if (!(await hasQuestionBlockGenesisAnchor(tx, params.blockId))) {
    throw new Error(
      'canonical question block edit requires complete history; run deployment migration',
    );
  }
  // One clock: the row's updated_at must equal the event's created_at for byte-exact folds.
  const now = new Date();
  const version = params.currentVersion + 1;

  // SSE transport row, orthogonal to the canonical event log.
  await writeJobEvent(tx, {
    business_table: 'question_block',
    business_id: params.blockId,
    event_type: 'block.structured_edited',
    payload: params.jobPayload,
  });

  // Canonical event goes first so the projection/parity assert can read it. It carries
  // the primary block with the AFTER tree, new version, and current status; figures only
  // when re-pointed. A malformed payload throws at parseEvent and rolls back the tx.
  await writeEvent(tx, {
    id: newId(),
    actor_kind: params.actorKind,
    actor_ref: params.actorRef,
    action: 'experimental:edit_question_block_structured',
    subject_kind: 'question_block',
    subject_id: params.blockId,
    outcome: 'success',
    payload: {
      op: params.op,
      affected_blocks: [
        {
          block_id: params.blockId,
          role: 'primary',
          structured: params.structured,
          ...(params.figures !== undefined ? { figures: params.figures } : {}),
          version,
          status: params.currentStatus,
        },
      ],
    },
    created_at: now,
    ingest_at: now,
  });

  await projectQuestionBlockGuarded(tx, params.blockId);

  return version;
}

export interface UpdatePromptParams extends BaseEditParams {
  blockId: string;
  nodeId: string;
  promptText: string;
}

export async function updatePrompt(db: Db, params: UpdatePromptParams): Promise<EditResult> {
  return db.transaction(async (tx) => {
    const block = await loadBlockForUpdate(tx, params.blockId);
    if (!block) return { status: 'skipped:block_not_found' };
    if (block.status !== 'draft') return { status: 'skipped:not_draft' };
    if (!block.structured) return { status: 'skipped:node_not_found' };

    const { tree, matched } = mapNodeById(block.structured, params.nodeId, (n) => {
      n.prompt_text = params.promptText;
      stampProvenance(n, params.actorRef);
    });
    if (!matched) return { status: 'skipped:node_not_found' };

    const version = await persistStructured(tx, {
      blockId: params.blockId,
      structured: tree,
      op: 'update_prompt',
      jobPayload: { op: 'update_prompt', node_id: params.nodeId },
      actorRef: params.actorRef,
      actorKind: params.actorKind ?? 'agent',
      currentStatus: block.status,
      currentVersion: block.version,
    });
    return { status: 'written', version };
  });
}

export interface AddOptionParams extends BaseEditParams {
  blockId: string;
  nodeId: string;
  option: { label: string; text: string };
}

export async function addOption(db: Db, params: AddOptionParams): Promise<EditResult> {
  return db.transaction(async (tx) => {
    const block = await loadBlockForUpdate(tx, params.blockId);
    if (!block) return { status: 'skipped:block_not_found' };
    if (block.status !== 'draft') return { status: 'skipped:not_draft' };
    if (!block.structured) return { status: 'skipped:node_not_found' };

    const { tree, matched } = mapNodeById(block.structured, params.nodeId, (n) => {
      n.options = [...(n.options ?? []), { label: params.option.label, text: params.option.text }];
      stampProvenance(n, params.actorRef);
    });
    if (!matched) return { status: 'skipped:node_not_found' };

    const version = await persistStructured(tx, {
      blockId: params.blockId,
      structured: tree,
      op: 'add_option',
      jobPayload: { op: 'add_option', node_id: params.nodeId },
      actorRef: params.actorRef,
      actorKind: params.actorKind ?? 'agent',
      currentStatus: block.status,
      currentVersion: block.version,
    });
    return { status: 'written', version };
  });
}

export interface SetQuestionTypeParams extends BaseEditParams {
  blockId: string;
  nodeId: string;
  kind: z.infer<typeof QuestionKind>;
}

export async function setQuestionType(db: Db, params: SetQuestionTypeParams): Promise<EditResult> {
  return db.transaction(async (tx) => {
    const block = await loadBlockForUpdate(tx, params.blockId);
    if (!block) return { status: 'skipped:block_not_found' };
    if (block.status !== 'draft') return { status: 'skipped:not_draft' };
    if (!block.structured) return { status: 'skipped:node_not_found' };

    const { tree, matched } = mapNodeById(block.structured, params.nodeId, (n) => {
      n.kind = params.kind;
      stampProvenance(n, params.actorRef);
    });
    if (!matched) return { status: 'skipped:node_not_found' };

    const version = await persistStructured(tx, {
      blockId: params.blockId,
      structured: tree,
      op: 'set_question_type',
      jobPayload: { op: 'set_question_type', node_id: params.nodeId, kind: params.kind },
      actorRef: params.actorRef,
      actorKind: params.actorKind ?? 'agent',
      currentStatus: block.status,
      currentVersion: block.version,
    });
    return { status: 'written', version };
  });
}

export interface SplitStemParams extends BaseEditParams {
  blockId: string;
  nodeId: string;
}

/** Promotes sub_questions to standalone nodes, preserving order and stamping provenance. */
function promoteSubsToStandalone(
  stem: StructuredQuestionT,
  actorRef: string,
): StructuredQuestionT[] {
  return (stem.sub_questions ?? []).map((sub) => {
    const clone: StructuredQuestionT = { ...sub, role: 'standalone', sub_questions: undefined };
    stampProvenance(clone, actorRef);
    return clone;
  });
}

function isSplittableStem(node: StructuredQuestionT): boolean {
  return node.role === 'stem' && (node.sub_questions?.length ?? 0) > 0;
}

/**
 * Un-groups the target stem within its block. A root stem keeps an empty shell
 * holding the promoted children, because a single-root tree cannot hold sibling roots.
 * A nested stem is spliced out and replaced by its promoted children.
 *
 * Splitting a nested stem removes its id, so figures attached to it would dangle;
 * reattachFrom/reattachTo let the caller re-point them. Root-stem splits keep the id.
 */
function splitStemInTree(
  node: StructuredQuestionT,
  target: string,
  actorRef: string,
): {
  tree: StructuredQuestionT;
  outcome: 'split' | 'not_found' | 'not_splittable';
  reattachFrom?: string;
  reattachTo?: string;
} {
  if (node.id === target) {
    if (!isSplittableStem(node)) return { tree: node, outcome: 'not_splittable' };
    const shell: StructuredQuestionT = {
      id: node.id,
      role: 'stem',
      prompt_text: '',
      source: 'agent_edit',
      last_modified_by: actorRef,
      sub_questions: promoteSubsToStandalone(node, actorRef),
    };
    // The root stem keeps its id via the shell, so nothing dangles.
    return { tree: shell, outcome: 'split' };
  }

  let outcome: 'split' | 'not_found' | 'not_splittable' = 'not_found';
  let reattachFrom: string | undefined;
  let reattachTo: string | undefined;
  const nextSubs: StructuredQuestionT[] = [];
  for (const sub of node.sub_questions ?? []) {
    if (sub.id === target) {
      if (!isSplittableStem(sub)) {
        nextSubs.push(sub);
        outcome = 'not_splittable';
      } else {
        const promoted = promoteSubsToStandalone(sub, actorRef);
        nextSubs.push(...promoted);
        outcome = 'split';
        // The stem id vanishes on splice; re-point its figures to the first promoted child.
        reattachFrom = sub.id;
        reattachTo = promoted[0]?.id;
      }
      continue;
    }
    const res = splitStemInTree(sub, target, actorRef);
    nextSubs.push(res.tree);
    if (res.outcome === 'split') outcome = 'split';
    else if (res.outcome === 'not_splittable' && outcome === 'not_found') {
      outcome = 'not_splittable';
    }
    if (res.reattachFrom) {
      reattachFrom = res.reattachFrom;
      reattachTo = res.reattachTo;
    }
  }
  const clone: StructuredQuestionT = {
    ...node,
    sub_questions: node.sub_questions ? nextSubs : undefined,
  };
  return { tree: clone, outcome, reattachFrom, reattachTo };
}

export async function splitStem(db: Db, params: SplitStemParams): Promise<EditResult> {
  return db.transaction(async (tx) => {
    const block = await loadBlockForUpdate(tx, params.blockId);
    if (!block) return { status: 'skipped:block_not_found' };
    if (block.status !== 'draft') return { status: 'skipped:not_draft' };
    if (!block.structured) return { status: 'skipped:node_not_found' };
    if (!idHasMatch(block.structured, params.nodeId)) {
      return { status: 'skipped:node_not_found' };
    }

    const result = splitStemInTree(block.structured, params.nodeId, params.actorRef);
    if (result.outcome === 'not_found') return { status: 'skipped:node_not_found' };
    if (result.outcome === 'not_splittable') return { status: 'skipped:not_splittable' };

    // Re-point figures off the removed stem id; the root-stem case leaves this unset.
    let nextFigures: FigureRefT[] | undefined;
    if (result.reattachFrom && result.reattachTo) {
      const from = result.reattachFrom;
      const to = result.reattachTo;
      nextFigures = (block.figures ?? []).map((f) =>
        f.attached_to_index === from ? { ...f, attached_to_index: to } : f,
      );
    }

    const version = await persistStructured(tx, {
      blockId: params.blockId,
      structured: result.tree,
      op: 'split_stem',
      jobPayload: { op: 'split_stem', node_id: params.nodeId },
      actorRef: params.actorRef,
      actorKind: params.actorKind ?? 'agent',
      currentStatus: block.status,
      currentVersion: block.version,
      figures: nextFigures,
    });
    return { status: 'written', version };
  });
}

export interface SetPresentationValidation {
  status: 'valid' | 'invalid' | 'rejected_input' | 'unresolvable_contract' | 'unsupported_contract';
  issues: { code: string; detail: string }[];
}

interface SetPresentationOptions extends BaseEditParams {
  blockId: string;
  expectedVersion?: number;
  requestId?: string;
  /** Defaults to save for existing callers. Validation runs under the same row lock. */
  save?: boolean;
}

export type SetPresentationParams = SetPresentationOptions &
  (
    | { presentation: PresentationT; structured?: never }
    // Legacy callers: consume only presentation, never their supplied AFTER tree.
    | { structured: StructuredQuestionT; presentation?: never }
  );

export type SetPresentationStatus =
  | 'written'
  | 'validated'
  | 'conflict'
  | 'invalid'
  | 'rejected_input'
  | 'unresolvable_contract'
  | 'unsupported_contract'
  | 'skipped:not_draft'
  | 'skipped:block_not_found'
  | 'skipped:null_structured';

export interface SetPresentationResult {
  status: SetPresentationStatus;
  /** Set on `written`; the post-save block version. */
  version?: number;
  draft_ref?: string;
  request_id?: string;
  replayed?: boolean;
  reason?: string;
  current_draft_ref?: string;
  current_draft_version?: number;
  issues?: { code: string; detail: string }[];
}

/** legacy draft block → normalizer 行投影（与导入/发布同一形状来源）。 */
function draftRowProjection(
  blockId: string,
  structured: StructuredQuestionT,
  payload: {
    reference_md: string | null;
    figures: { asset_id: string }[];
  },
): NormalizableQuestionRow {
  const shape = capturedQuestionShape(structured);
  return {
    id: blockId,
    kind: shape.kind,
    // 导入把块铸成 question 行时 prompt_md = structuredToPromptMarkdown(
    // structured)（auto-enroll / import-completion 同一派生函数），reference_md
    // 取块列 —— 与发布读到的行逐字同源，stem material id 因此与真实发布一致。
    prompt_md: structuredToPromptMarkdown(structured),
    reference_md: payload.reference_md,
    rubric_json: null,
    choices_md: shape.choices_md,
    judge_kind_override: null,
    structured,
    figures: payload.figures as NormalizableQuestionRow['figures'],
  };
}

/** 与发布同一 normalizer（单行路径）推导 draft 的（未来）契约；失败返回 null（不伪造）。 */
async function deriveDraftContract(
  db: Db | Tx,
  blockId: string,
  structured: StructuredQuestionT,
  payload: { reference_md: string | null; figures: { asset_id: string }[] },
) {
  const assetIds = [...new Set(payload.figures.map((figure) => figure.asset_id))];
  const figureDigests: Record<string, string> = {};
  if (assetIds.length > 0) {
    const assetRows = await db
      .select({ assetId: source_asset.id, sha256: source_asset.sha256 })
      .from(source_asset)
      .where(inArray(source_asset.id, assetIds));
    for (const row of assetRows) figureDigests[row.assetId] = row.sha256;
  }
  try {
    return normalizeQuestionRowToContract({
      ...draftRowProjection(blockId, structured, payload),
      figureDigests: Object.keys(figureDigests).length > 0 ? figureDigests : null,
    });
  } catch {
    return null;
  }
}

/** Draft presentation admission always reads the row locked by setPresentation. */
async function validateDraftPresentation(
  tx: Tx,
  block: BlockRow,
  presentation: PresentationT | undefined,
  params: SetPresentationOptions,
  save: boolean,
): Promise<SetPresentationValidation> {
  if (presentation == null) {
    return {
      status: 'rejected_input',
      issues: [{ code: 'malformed_presentation', detail: 'presentation is required' }],
    };
  }
  const raw: unknown = block.structured;
  if (raw != null && typeof raw === 'object' && 'schema_version' in raw) {
    if (raw.schema_version !== DRAFT_DOCUMENT_SCHEMA_VERSION) {
      return {
        status: 'unsupported_contract',
        issues: [
          {
            code: 'unsupported_draft_version',
            detail: `schema_version ${String(raw.schema_version)}`,
          },
        ],
      };
    }
    const parsed = QuestionDraftDocument.safeParse(raw);
    if (!parsed.success) {
      return {
        status: 'rejected_input',
        issues: parsed.error.issues.slice(0, 10).map((issue) => ({
          code: 'invalid_draft_document',
          detail: `${issue.path.join('.')}: ${issue.message}`,
        })),
      };
    }
    if (save && (params.expectedVersion == null || params.requestId == null)) {
      return {
        status: 'rejected_input',
        issues: [
          {
            code: 'missing_save_identity',
            detail: 'v2 save requires draft_ref/version and request_id',
          },
        ],
      };
    }
    const doc = parsed.data;
    for (const part of doc.parts) {
      for (const unit of part.units) {
        if (unit.response_spec.kind !== 'blank' || unit.response_spec.answer_shape == null)
          continue;
        const support = declaredShapeSupport(unit.response_spec.answer_shape);
        if (!support.supported) {
          return {
            status: 'unsupported_contract',
            issues: [
              {
                code: 'unsupported_answer_shape',
                detail: `slot ${unit.slot_id}: ${support.reason}`,
              },
            ],
          };
        }
      }
    }
    try {
      // Submit chooses a real group id for a new question. Bindings name stable
      // material/part/unit/slot ids, never this draft-only group placeholder.
      const contract = draftDocumentToContract(
        doc,
        doc.base?.question_id ?? block.imported_question_id ?? `draft-${block.id}`,
      );
      const issues: SetPresentationValidation['issues'] = [
        ...contract.conversion_issues.filter((issue) => issue.code === 'duplicate_id'),
        ...validateStructure(contract.structure),
        ...validateResponseSpec(contract.response_spec, contract.structure),
        ...validatePresentation(
          presentation,
          contract.structure,
          contract.response_spec,
          contract.scoring_basis,
        ),
      ];
      return { status: issues.length === 0 ? 'valid' : 'invalid', issues };
    } catch (error) {
      // A recognized v2 document never drops into legacy normalization.
      return {
        status: 'unresolvable_contract',
        issues: [
          {
            code: 'invalid_draft_contract',
            detail: error instanceof Error ? error.message : 'v2 conversion failed',
          },
        ],
      };
    }
  }
  if (!isLegacyStructuredQuestion(raw)) {
    return {
      status: 'unresolvable_contract',
      issues: [
        {
          code: 'unrecognized_draft',
          detail: 'expected v2 document or legacy structured question',
        },
      ],
    };
  }
  const contract = await deriveDraftContract(tx, params.blockId, raw, {
    reference_md: block.reference_md,
    figures: block.figures ?? [],
  });
  if (contract == null) return { status: 'unresolvable_contract', issues: [] };
  const issues = validatePresentation(
    presentation,
    contract.structure,
    contract.response_spec,
    contract.scoring_basis,
  );
  return { status: issues.length === 0 ? 'valid' : 'invalid', issues };
}

/**
 * Persists a validated presentation through the standard single-block edit channel.
 * Owns request lock → replay → row lock → CAS → validation → canonical save/receipt.
 * Draft admission reads the locked version; only presentation is merged into that row.
 */
export async function setPresentation(
  db: Db | Tx,
  params: SetPresentationParams,
): Promise<SetPresentationResult> {
  return db.transaction(async (tx) => {
    const save = params.save !== false;
    const presentation = params.presentation ?? params.structured?.presentation;
    // Same request lock and receipt action as edit_question. The tool/actor-bound
    // fingerprint keeps a reused edit/compose key from replaying another operation.
    const fingerprint = `sha256:${sha256CanonicalJson({
      tool: 'compose_presentation',
      block_id: params.blockId,
      expected_version: params.expectedVersion ?? null,
      presentation,
      actor_ref: params.actorRef,
      actor_kind: params.actorKind ?? 'agent',
    })}`;
    if (save && params.requestId != null) {
      // Always before the row lock, matching edit/submit's lock order.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${params.requestId}))`);
      const [existing] = await tx
        .select({ payload: event.payload })
        .from(event)
        .where(
          and(
            eq(event.action, 'experimental:question_draft_save'),
            sql`${event.payload} ->> 'request_id' = ${params.requestId}`,
          ),
        )
        .orderBy(desc(event.created_at))
        .limit(1);
      if (existing != null) {
        const payload = existing.payload as {
          fingerprint: string;
          receipt: SetPresentationResult;
        };
        if (payload.fingerprint !== fingerprint) {
          return { status: 'conflict', reason: 'request_id_reused', request_id: params.requestId };
        }
        return { ...payload.receipt, replayed: true };
      }
    }
    const block = await loadBlockForUpdate(tx, params.blockId);
    if (!block) return { status: 'skipped:block_not_found' };
    if (block.status !== 'draft') return { status: 'skipped:not_draft' };
    if (!block.structured) return { status: 'skipped:null_structured' };
    if (params.expectedVersion != null && params.expectedVersion !== block.version) {
      return {
        status: 'conflict',
        reason: 'draft_version_cas',
        current_draft_ref: encodeDraftRef(block.id, block.version),
        current_draft_version: block.version,
      };
    }
    const validation = await validateDraftPresentation(tx, block, presentation, params, save);
    if (validation.status !== 'valid') {
      return { status: validation.status, issues: validation.issues };
    }
    if (!save) {
      return {
        status: 'validated',
        version: block.version,
        draft_ref: encodeDraftRef(block.id, block.version),
      };
    }

    const version = await persistStructured(tx, {
      blockId: params.blockId,
      structured: { ...block.structured, presentation },
      op: 'set_presentation',
      jobPayload: { op: 'set_presentation' },
      actorRef: params.actorRef,
      actorKind: params.actorKind ?? 'agent',
      currentStatus: block.status,
      currentVersion: block.version,
    });
    const receipt: SetPresentationResult = {
      status: 'written',
      version,
      draft_ref: encodeDraftRef(block.id, version),
      ...(params.requestId != null ? { request_id: params.requestId } : {}),
    };
    if (params.requestId != null) {
      // Existing draft-save receipt, atomic with the canonical edit and projection.
      // Replays return this original version/ref even if later edits have advanced it.
      await writeEvent(tx, {
        id: newId(),
        actor_kind: params.actorKind ?? 'agent',
        actor_ref: params.actorRef,
        action: 'experimental:question_draft_save',
        subject_kind: 'question_block',
        subject_id: block.id,
        outcome: 'success',
        payload: { request_id: params.requestId, fingerprint, receipt },
        ingest_at: new Date(),
      });
    }
    return receipt;
  });
}

export interface MergeQuestionsParams extends BaseEditParams {
  primaryBlockId: string;
  mergeBlockIds: string[];
  /**
   * Optional admission gate run inside this transaction, after the row locks and
   * guards but before any write. The proposal-accept path re-binds its admission proof
   * to the locked rows; throwing rolls back with no mutation.
   */
  admission?: (ctx: { tx: Tx; primary: BlockRow; mergeBlocks: BlockRow[] }) => Promise<void> | void;
}

/** Top-level structured nodes of a block, normalised to an array. */
function topLevelNodes(structured: StructuredQuestionT | null): StructuredQuestionT[] {
  if (!structured) return [];
  // A block holds one root tree; absorb that root, sub-questions included.
  return [structured];
}

export async function mergeQuestions(db: Db, params: MergeQuestionsParams): Promise<EditResult> {
  return db.transaction(async (tx) => {
    const primary = await loadBlockForUpdate(tx, params.primaryBlockId);
    if (!primary) return { status: 'skipped:block_not_found' };
    if (primary.status !== 'draft') return { status: 'skipped:not_draft' };

    // Dedupe and drop the primary so merged_from_block_ids is not inflated.
    const mergeIds = [...new Set(params.mergeBlockIds)].filter(
      (id) => id !== params.primaryBlockId,
    );
    if (mergeIds.length === 0) return { status: 'skipped:block_not_found' };

    const mergeBlocks = await tx
      .select()
      .from(question_block)
      .where(inArray(question_block.id, mergeIds))
      .for('update');
    // Every requested merge block must exist.
    if (mergeBlocks.length !== mergeIds.length) return { status: 'skipped:block_not_found' };
    // All blocks must be draft.
    if (mergeBlocks.some((b) => b.status !== 'draft')) return { status: 'skipped:not_draft' };
    // All blocks must share the primary's ingestion_session_id.
    if (mergeBlocks.some((b) => b.ingestion_session_id !== primary.ingestion_session_id)) {
      return { status: 'skipped:cross_session' };
    }
    // A null-structured block has no node to absorb; merging it would silently drop
    // its legacy prompt while marking the block ignored.
    if (!primary.structured) return { status: 'skipped:null_structured' };
    if (mergeBlocks.some((b) => b.structured === null)) {
      return { status: 'skipped:null_structured' };
    }

    // The admission gate sees the locked rows before any write; a throw rolls back all.
    await params.admission?.({ tx, primary, mergeBlocks });

    // Append each merged block's root as a sub_question of the primary, in order.
    const primaryNodes = topLevelNodes(primary.structured);
    // Use mergeIds order, not the unordered SELECT result, for deterministic output.
    const blocksById = new Map(mergeBlocks.map((b) => [b.id, b]));
    const absorbed: StructuredQuestionT[] = [];
    for (const id of mergeIds) {
      const mb = blocksById.get(id);
      if (!mb) continue; // unreachable: length check above guarantees presence
      for (const node of topLevelNodes(mb.structured)) {
        // Keep a stem root a nested stem: forcing role='sub' on a node with
        // sub_questions is schema-illegal and markdown would drop the children.
        const isStem = node.role === 'stem' && (node.sub_questions?.length ?? 0) > 0;
        const clone: StructuredQuestionT = isStem
          ? structuredClone(node)
          : { ...node, role: 'sub', sub_questions: undefined };
        // Stamp provenance only on the absorbed top node (subs keep their own).
        stampProvenance(clone, params.actorRef);
        absorbed.push(clone);
      }
    }
    const existingSubs =
      primary.structured && primary.structured.role === 'stem'
        ? (primary.structured.sub_questions ?? [])
        : primaryNodes.map((n) => ({ ...n, role: 'sub' as const }));
    const mergedTree: StructuredQuestionT = {
      id: primary.structured?.id ?? params.primaryBlockId,
      role: 'stem',
      prompt_text: primary.structured?.role === 'stem' ? primary.structured.prompt_text : '',
      source: 'agent_edit',
      last_modified_by: params.actorRef,
      sub_questions: [...existingSubs, ...absorbed],
    };

    // Union figures in mergeIds order. Node ids survive the merge, so attachments
    // still resolve. Dedupe by asset_id: reassignFigure matches the first asset_id,
    // so a duplicate would shadow updates and double-render in review.
    const seenAssetIds = new Set<string>();
    const mergedFigures: FigureRefT[] = [
      ...(primary.figures ?? []),
      ...mergeIds.flatMap((id) => blocksById.get(id)?.figures ?? []),
    ].filter((f) => !seenAssetIds.has(f.asset_id) && seenAssetIds.add(f.asset_id));

    // One clock for both updates and the canonical event so the fold reproduces every
    // updated_at exactly.
    const now = new Date();
    for (const id of [params.primaryBlockId, ...mergeIds]) {
      if (!(await hasQuestionBlockGenesisAnchor(tx, id))) {
        throw new Error(
          'canonical question block merge requires complete history; run deployment migration',
        );
      }
    }
    const primaryVersion = primary.version + 1;

    await writeJobEvent(tx, {
      business_table: 'question_block',
      business_id: params.primaryBlockId,
      event_type: 'block.structured_edited',
      payload: { op: 'merge_questions', merged_from_block_ids: mergeIds },
    });
    for (const id of mergeIds) {
      await writeJobEvent(tx, {
        business_table: 'question_block',
        business_id: id,
        event_type: 'block.structured_edited',
        payload: { op: 'merge_questions', merged_into_block_id: params.primaryBlockId },
      });
    }

    // One canonical event replaces the 1+N transport rows. The primary carries the AFTER
    // tree, figures, bumped version, and unchanged status; each absorbed block carries
    // status 'ignored', its unchanged version, and its before-tree for undo. Ordering
    // matches the live writer so the fold appends the same merged_from_block_ids.
    const mergedSourceEntries = mergeIds.map((id) => {
      const mb = blocksById.get(id);
      if (!mb) {
        // unreachable: the mergeBlocks.length === mergeIds.length check above guarantees presence.
        throw new Error(`mergeQuestions: merge block ${id} vanished before snapshot`);
      }
      return {
        block_id: id,
        role: 'merged_source' as const,
        structured: mb.structured,
        version: mb.version,
        status: 'ignored',
      };
    });
    await writeEvent(tx, {
      id: newId(),
      actor_kind: params.actorKind ?? 'agent',
      actor_ref: params.actorRef,
      action: 'experimental:edit_question_block_structured',
      subject_kind: 'question_block',
      subject_id: params.primaryBlockId,
      outcome: 'success',
      payload: {
        op: 'merge_questions',
        affected_blocks: [
          {
            block_id: params.primaryBlockId,
            role: 'primary',
            structured: mergedTree,
            figures: mergedFigures,
            version: primaryVersion,
            status: primary.status,
          },
          ...mergedSourceEntries,
        ],
      },
      created_at: now,
      ingest_at: now,
    });

    for (const id of [params.primaryBlockId, ...mergeIds]) {
      await projectQuestionBlockGuarded(tx, id);
    }
    return { status: 'written', version: primaryVersion };
  });
}

export interface ReassignFigureParams extends BaseEditParams {
  blockId: string;
  assetId: string;
  attachedToIndex: string;
}

export type ReassignFigureStatus =
  | 'written'
  | 'skipped:not_draft'
  | 'skipped:block_not_found'
  | 'skipped:figure_not_found'
  | 'skipped:target_not_found';

export interface ReassignFigureResult {
  status: ReassignFigureStatus;
  figures?: FigureRefT[];
  version?: number;
}

/**
 * Figure reassignment behind the `reassign_figure` tool. The tool enables the draft
 * guard and maps skipped results to its Output.
 */
export async function reassignFigure(
  db: Db,
  params: ReassignFigureParams & { enforceDraft?: boolean },
): Promise<ReassignFigureResult> {
  return db.transaction(async (tx) => {
    const block = await loadBlockForUpdate(tx, params.blockId);
    if (!block) return { status: 'skipped:block_not_found' };
    if (params.enforceDraft && block.status !== 'draft') {
      return { status: 'skipped:not_draft' };
    }

    const figures = block.figures ?? [];
    const idx = figures.findIndex((f) => f.asset_id === params.assetId);
    if (idx < 0) return { status: 'skipped:figure_not_found' };

    const structured = block.structured;
    if (!structured || !idHasMatch(structured, params.attachedToIndex)) {
      return { status: 'skipped:target_not_found' };
    }

    // One clock stamps the figure, the row, and the event, so the figures array and
    // updated_at match byte-for-byte in the fold.
    const now = new Date();
    const updatedFigures: FigureRefT[] = figures.map((f, i) =>
      i === idx
        ? {
            ...f,
            attached_to_index: params.attachedToIndex,
            attach_confidence: 'manual' as const,
            last_reassigned_at: now,
          }
        : f,
    );

    if (!(await hasQuestionBlockGenesisAnchor(tx, params.blockId))) {
      throw new Error(
        'canonical question block figure edit requires complete history; run deployment migration',
      );
    }
    const version = block.version + 1;

    await writeJobEvent(tx, {
      business_table: 'question_block',
      business_id: params.blockId,
      event_type: 'figure.reassigned',
      payload: { asset_id: params.assetId, attached_to_index: params.attachedToIndex },
    });

    // Canonical lifecycle event carries the full figures array and bumped version so the
    // re-point is fold-visible; the job event above remains the SSE transport.
    await writeQuestionBlockLifecycleEvent(tx, {
      blockId: params.blockId,
      op: 'reassign_figures',
      figures: updatedFigures,
      nextVersion: version,
      actorKind: params.actorKind ?? 'agent',
      actorRef: params.actorRef,
      now,
    });

    await projectQuestionBlockGuarded(tx, params.blockId);
    return { status: 'written', figures: updatedFigures, version };
  });
}
