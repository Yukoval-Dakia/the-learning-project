import { and, eq, inArray, sql } from 'drizzle-orm';
import { canonicalHash } from '@/core/migration/canonical';
import type { ResponseSetT, ResponseSlotT, ScoringBasisT } from '@/core/schema/assessment';
import { structuredToPromptMarkdown } from '@/core/schema/structured_question';
import type { Db } from '@/db/client';
import { acquireLearningStateWriteLock } from '@/db/learning-state-lock';
import {
  learning_session,
  question,
  question_block,
  question_group_lifecycle,
  question_revision,
  source_asset,
} from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { commitFormalAttempt, recordFormalAttemptCapture, saveSubmission } from '@/kernel/judge';
import { withAnswerClass } from '@/kernel/records/answer-class-write';
import { freezeImageEvidence } from '@/kernel/records/assessment-evidence';
import { issueCapturedAssessment } from '@/kernel/records/assessment-issuance';
import { publishQuestionGroupFromRow } from '@/kernel/records/assessment-publication';
import { writeQuestionBlockLifecycleEvent } from '@/kernel/records/question-block-lifecycle-event';
import type { AutoEnrolledBlock } from './auto-enroll';
import { capturedQuestionShape } from './captured-question-shape';
import { enrollCapturedBlock } from './enroll';
import { figuresForQuestion } from './figure_attach';

type Block = typeof question_block.$inferSelect;

// ---------- YUK-1445 (G8) — 逐小问/逐空捕获 ----------
//
// 拍照/作答卷上的作答按 scoring unit 读入 batch-A 响应信封：select 圈选 →
// 稳定 item_id；blank 识别文本 → 单槽 text；free → 原始图片证据。读不出的
// 一律 state:'unknown'（显式 pending，绝不伪零分）。红笔按学习者偏好归类：
// post_correction 不计入作答（判不出原始作答 → unknown）；learner_work /
// teacher_mark 照算。旧 flat 路径（wrong_answer_md 单槽回退）保持不变。

/** 红笔归类（学习者偏好，若声明）；缺省保守按 post_correction —— 订正
 *  内容绝不能冒充原始作答。 */
export type RedInkClassification = 'post_correction' | 'learner_work' | 'teacher_mark';

/** 一个 scoring unit（或其主槽）的拍照作答读取结果。 */
export interface CapturedUnitAnswer {
  /** 目标定位：slot_id 或 scoring_unit_id（经 basis.slot_refs 解析）二选一。 */
  slot_id?: string;
  scoring_unit_id?: string;
  /** 'unknown' = 识别不出（手写/涂抹不可读）；'blank' = 显式空白。 */
  state?: 'answered' | 'blank' | 'unknown';
  /** select：已解析为稳定 item_id 的圈选结果（优先于 item_labels）。 */
  item_ids?: string[];
  /** select：圈中的显示标签（A/B/C...），按 item label_md 前缀解析。 */
  item_labels?: string[];
  /** blank/free：识别出的文本。 */
  text?: string;
  /** 该区域观测到红笔。 */
  red_ink_observed?: boolean;
}

interface CaptureInput {
  block: Block;
  knowledgeIds: string[];
  difficulty: number;
  confidence: number;
  canEnroll: boolean;
  pageRefs: string[];
  now: Date;
  /** G8：逐单元读取结果；缺省 = 旧 flat 路径（wrong_answer_md 单槽）。 */
  unit_captures?: CapturedUnitAnswer[];
  /** 学习者红笔偏好（缺省保守 post_correction）。 */
  red_ink_preference?: RedInkClassification;
}

interface UnitCaptureRecord {
  slot_id: string;
  entry_kind: string;
  state: 'answered' | 'blank' | 'unknown' | 'omitted';
  ink: RedInkClassification | null;
}

/** 红笔归类：观测到红笔才分类；post_correction 内容不计入作答。 */
function classifyInk(
  capture: CapturedUnitAnswer | undefined,
  preference: RedInkClassification | undefined,
): RedInkClassification | null {
  if (capture?.red_ink_observed !== true) return null;
  return preference ?? 'post_correction';
}

/** select 标签 → item_id：匹配 label_md 前导 token（"A. xxx" 取 "A"）。 */
function resolveSelectLabels(
  slot: Extract<ResponseSlotT, { kind: 'select' }>,
  labels: readonly string[],
): { ok: true; item_ids: string[] } | { ok: false } {
  const itemIds: string[] = [];
  for (const raw of labels) {
    const label = raw
      .trim()
      .toUpperCase()
      .replace(/[.。]$/, '');
    if (!label) return { ok: false };
    const matches = slot.items.filter((item) => {
      const head = item.label_md?.split(/[.。\s]/)[0]?.toUpperCase();
      return head === label;
    });
    if (matches.length !== 1) return { ok: false };
    const itemId = matches[0]?.item_id;
    if (itemIds.includes(itemId)) return { ok: false };
    itemIds.push(itemId);
  }
  return { ok: true, item_ids: itemIds };
}

/** 逐槽构造 batch-A 信封；uc = 该槽的逐单元捕获（可缺省 → flat 回退）。 */
function capturedEntryFor(
  slot: ResponseSlotT,
  capture: CapturedUnitAnswer | undefined,
  ctx: {
    flatText: string;
    evidence: Awaited<ReturnType<typeof freezeImageEvidence>>;
    /** flat 文本只在全组单槽时可归属（旧行为）。 */
    allowFlat: boolean;
    redInkPreference?: RedInkClassification;
    records: UnitCaptureRecord[];
  },
): import('@/core/schema/assessment').SlotResponseT | undefined {
  const ink = classifyInk(capture, ctx.redInkPreference);
  const record = (state: UnitCaptureRecord['state'], entry_kind: string = slot.kind) =>
    ctx.records.push({ slot_id: slot.slot_id, entry_kind, state, ink });
  // post_correction：订正内容不算作答 —— 读不出原始作答即显式 unknown。
  const postCorrected = ink === 'post_correction';
  const unreadable = capture?.state === 'unknown' || postCorrected;

  switch (slot.kind) {
    case 'select': {
      const universe = new Set(slot.items.map((item) => item.item_id));
      let itemIds: string[] | null = null;
      if (!unreadable && capture?.state !== 'blank') {
        if (capture?.item_ids != null) {
          itemIds =
            capture.item_ids.every((id) => universe.has(id)) &&
            new Set(capture.item_ids).size === capture.item_ids.length
              ? [...capture.item_ids]
              : null;
        } else if (capture?.item_labels != null) {
          const resolved = resolveSelectLabels(slot, capture.item_labels);
          itemIds = resolved.ok ? resolved.item_ids : null;
        } else if (ctx.allowFlat && ctx.flatText.trim().length > 0) {
          // flat 回退：圈选字母 → item（与旧 single/multi 的 label 解析同语义）。
          const labels = ctx.flatText
            .trim()
            .toUpperCase()
            .split(/[\s,，、]+/)
            .filter(Boolean);
          const resolved = resolveSelectLabels(slot, labels);
          itemIds = resolved.ok ? resolved.item_ids : null;
        }
      }
      if (itemIds != null && itemIds.length > 0) {
        record('answered');
        return {
          slot_id: slot.slot_id,
          kind: 'select',
          state: 'answered',
          item_ids: itemIds,
        } as const;
      }
      if (capture?.state === 'blank' && !postCorrected) {
        record('blank');
        return { slot_id: slot.slot_id, kind: 'select', state: 'blank', item_ids: [] } as const;
      }
      if (capture != null || unreadable || ctx.allowFlat) {
        // 有捕获但解析失败 / 显式 unreadable / flat 字母解析失败 → unknown（显式未决）。
        record('unknown');
        return { slot_id: slot.slot_id, kind: 'select', state: 'unknown', item_ids: [] } as const;
      }
      record('omitted');
      return undefined;
    }
    case 'blank': {
      if (unreadable) {
        record('unknown');
        return { slot_id: slot.slot_id, kind: 'blank', state: 'unknown', text: '' } as const;
      }
      if (capture?.state === 'blank') {
        record('blank');
        return { slot_id: slot.slot_id, kind: 'blank', state: 'blank', text: '' } as const;
      }
      const text = capture?.text ?? (ctx.allowFlat ? ctx.flatText : undefined);
      if (text == null) {
        record('omitted');
        return undefined;
      }
      if (text.trim().length === 0) {
        record('blank');
        return { slot_id: slot.slot_id, kind: 'blank', state: 'blank', text: '' } as const;
      }
      record('answered');
      return { slot_id: slot.slot_id, kind: 'blank', state: 'answered', text } as const;
    }
    case 'open_response': {
      if (unreadable) {
        // free 单元：原文证据照留，文字面为空 → 判分链如实 pending。
        record('unknown');
        return {
          slot_id: slot.slot_id,
          kind: 'open',
          text_md: '',
          evidence: ctx.evidence,
        } as const;
      }
      const text = capture?.text ?? (ctx.allowFlat ? ctx.flatText : '');
      if (capture == null && !ctx.allowFlat) {
        record('omitted');
        return undefined;
      }
      record(capture?.state === 'blank' || text.trim().length === 0 ? 'blank' : 'answered');
      return {
        slot_id: slot.slot_id,
        kind: 'open',
        text_md: text,
        evidence: ctx.evidence,
      } as const;
    }
    default:
      break;
  }

  // ---- legacy 槽位（旧题保持原行为；逐单元捕获可作用于选择/文本槽） ----
  const text = capture?.text ?? (ctx.allowFlat ? ctx.flatText : '');
  if (capture != null && capture.state === 'unknown') {
    record('omitted', `${slot.kind}:unknown`);
    return undefined;
  }
  if (slot.kind === 'single_choice' || slot.kind === 'multi_choice') {
    const labels = (
      capture?.item_labels ??
      text
        .trim()
        .toUpperCase()
        .split(/[\s,，、]+/)
        .filter(Boolean)
    ).map((l) =>
      l
        .trim()
        .toUpperCase()
        .replace(/[.。]$/, ''),
    );
    const byLabel = new Map(slot.options.map((o) => [o.label.toUpperCase(), o.option_id] as const));
    // 与旧 flat 语义一致：任一标签不可解析 ⇒ 整条不落信封（missing → pending）。
    const optionIds =
      labels.length > 0 && labels.every((l) => byLabel.has(l))
        ? labels.flatMap((l) => {
            const id = byLabel.get(l);
            return id != null ? [id] : [];
          })
        : [];
    const capturedIds = (capture?.item_ids ?? []).filter((id) =>
      slot.options.some((o) => o.option_id === id),
    );
    const ids = capturedIds.length > 0 ? capturedIds : optionIds;
    if (
      ids.length > 0 &&
      new Set(ids).size === ids.length &&
      !(slot.kind === 'single_choice' && ids.length > 1)
    ) {
      record('answered', 'choice');
      return { slot_id: slot.slot_id, kind: 'choice', option_ids: ids } as const;
    }
    record('omitted', 'choice');
    return undefined;
  }
  if (slot.kind === 'text' && (ctx.allowFlat || text.length > 0 || capture != null)) {
    // 旧 flat 行为：单槽 text 恒发条目（空 text_md 即旧“空文本”语义，保持逐字节一致）。
    record(text.length > 0 ? 'answered' : 'omitted', 'text');
    return { slot_id: slot.slot_id, kind: 'text', text_md: text } as const;
  }
  record('omitted', slot.kind);
  return undefined;
}

/** A receipt for existing work; failed/unadmitted scoring cannot roll it back. */
export async function captureIngestionOriginal(db: Db, input: CaptureInput) {
  const { block, now } = input;
  const captureId = canonicalHash({
    session: block.ingestion_session_id,
    block: block.id,
    version: block.version,
  }).slice(0, 40);
  const questionId = `q_capture_${captureId}`;
  const sourceDigest = canonicalHash({
    structured: block.structured,
    prompt: block.extracted_prompt_md,
    reference: block.reference_md,
    answer: block.wrong_answer_md,
    figures: block.figures,
    pages: block.source_asset_ids,
    page_spans: block.page_spans,
    image_refs: block.image_refs,
    // G8：逐单元捕获也是 capture 身份的一部分 —— 同一块不同的 per-unit
    // 读数不得复用旧 capture（capture_conflict 如实冲突）。
    unit_captures: input.unit_captures ?? null,
    red_ink_preference: input.red_ink_preference ?? null,
  });
  return db.transaction(async (tx) => {
    await acquireLearningStateWriteLock(tx);
    const [current] = await tx
      .select()
      .from(question_block)
      .where(eq(question_block.id, block.id))
      .for('update');
    const [session] = await tx
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, block.ingestion_session_id));
    if (
      current?.status !== 'draft' ||
      current.version !== block.version ||
      session?.type !== 'ingestion' ||
      session.status !== 'extracted'
    )
      return null;
    if (input.pageRefs.some((id) => !current.source_asset_ids.includes(id)))
      throw new ApiError(
        'capture_asset_mismatch',
        'answer page is outside the captured block',
        409,
      );
    const [existing] = await tx.select().from(question).where(eq(question.id, questionId));
    if (existing && existing.metadata?.capture_input_digest !== sourceDigest)
      throw new ApiError(
        'capture_conflict',
        'capture identity already binds different originals',
        409,
      );
    if (!existing) {
      const figureAssets = block.figures.length
        ? await tx
            .select({
              id: source_asset.id,
              storage_key: source_asset.storage_key,
              sha256: source_asset.sha256,
            })
            .from(source_asset)
            .where(
              inArray(
                source_asset.id,
                block.figures.map((figure) => figure.asset_id),
              ),
            )
        : [];
      await tx.insert(question).values(
        withAnswerClass({
          id: questionId,
          ...capturedQuestionShape(block.structured),
          prompt_md: block.structured
            ? structuredToPromptMarkdown(block.structured)
            : (block.extracted_prompt_md ?? ''),
          reference_md: block.reference_md,
          structured: block.structured,
          figures: figuresForQuestion(block.structured, block.figures, {
            sourceAssetIds: block.source_asset_ids,
            assets: figureAssets,
          }),
          image_refs: block.image_refs,
          knowledge_ids: input.knowledgeIds,
          difficulty: input.difficulty,
          source: session.entrypoint ?? 'vision_paper',
          variant_depth: 0,
          draft_status: 'draft',
          metadata: {
            ingestion_session_id: session.id,
            question_block_id: block.id,
            source_document_id: session.source_document_id,
            capture_block_version: block.version,
            capture_input_digest: sourceDigest,
            source_asset_ids: block.source_asset_ids,
          },
          created_at: now,
          updated_at: now,
          version: 0,
        }),
      );
      await publishQuestionGroupFromRow(tx, {
        rootId: questionId,
        actorRef: 'ingestion:capture',
        now,
      });
    }
    const [lifecycle] = await tx
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, questionId));
    if (!lifecycle?.current_revision_id) throw new Error('capture publication missing');
    const issued = await issueCapturedAssessment(tx, {
      group_id: questionId,
      issuance_id: `iss_capture_${captureId}`,
      now,
      source: { session_id: session.id, block_id: block.id, block_version: block.version },
    });
    if (!('issuance' in issued))
      throw new ApiError(issued.status, 'capture could not bind its revision', 409);
    const [revision] = await tx
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, issued.issuance.binding.revision_id));
    if (!revision) throw new Error('capture revision missing');
    const evidence = await freezeImageEvidence(tx, input.pageRefs);
    const text = block.wrong_answer_md ?? '';
    const slots = revision.response_spec.slots;
    const basis: ScoringBasisT = revision.scoring_basis;
    const captureRecords: UnitCaptureRecord[] = [];
    // scoring_unit_id → 主槽映射（逐单元捕获可按 unit 或 slot 定位）。
    const slotByUnitId = new Map<string, string>();
    for (const unit of basis.units) {
      const firstSlot = unit.slot_refs[0];
      if (unit.slot_refs.length === 1 && firstSlot != null) {
        slotByUnitId.set(unit.scoring_unit_id, firstSlot);
      }
    }
    const captureBySlot = new Map<string, CapturedUnitAnswer>();
    for (const capture of input.unit_captures ?? []) {
      const slotId = capture.slot_id ?? slotByUnitId.get(capture.scoring_unit_id ?? '');
      if (slotId != null && !captureBySlot.has(slotId)) captureBySlot.set(slotId, capture);
    }
    const entries: ResponseSetT['entries'] = [];
    // flat 文本只在全组单槽时可归属（旧行为）；逐单元捕获按槽精确落位。
    const allowFlat = slots.length === 1;
    for (const slot of slots) {
      const entry = capturedEntryFor(slot, captureBySlot.get(slot.slot_id), {
        flatText: text,
        evidence,
        allowFlat,
        redInkPreference: input.red_ink_preference,
        records: captureRecords,
      });
      if (entry != null) entries.push(entry);
    }
    const request = {
      issuance_id: issued.issuance.issuance_id,
      evaluation_group_id: `eg_capture_${captureId}`,
      submission_id: `sub_capture_${captureId}`,
      idempotency_key: `capture:${captureId}`,
      response_set: { entries },
      group_evidence: evidence.map((item) => ({
        evidence: item,
        target: { scope: 'all_units' as const },
      })),
      now,
    };
    const saved = await saveSubmission(tx, { ...request, actorRef: 'ingestion:capture' });
    if (!('submission' in saved))
      throw new ApiError(saved.status, 'capture original was not accepted', 409);
    await recordFormalAttemptCapture(tx, 'ingestion_grading', questionId, saved.submission, null, {
      response_md: text,
      session_id: session.id,
      ingestion: {
        block_id: block.id,
        block_version: block.version,
        source_document_id: session.source_document_id ?? '',
        source_asset_ids: block.source_asset_ids,
        generated_by: 'workflow_judge',
        // G8：逐单元读入的落位/未决与红笔归类留痕（不判分）。
        ...(captureRecords.length > 0
          ? {
              unit_captures: captureRecords,
              red_ink_preference: input.red_ink_preference ?? null,
            }
          : {}),
      },
    });
    return {
      request,
      questionId,
      sourceDocumentId: session.source_document_id ?? '',
      knowledgeIds: existing?.knowledge_ids ?? input.knowledgeIds,
      admitted: lifecycle.scoring_admission_state === 'admitted',
    };
  });
}

export async function enrollNativeCapture(
  db: Db,
  input: CaptureInput,
): Promise<AutoEnrolledBlock | null> {
  const captured = await captureIngestionOriginal(db, input);
  if (!captured?.admitted || !input.canEnroll || captured.knowledgeIds.length === 0) return null;
  let enrolled: AutoEnrolledBlock | null = null;
  await commitFormalAttempt(db, 'ingestion_grading', captured.questionId, captured.request, {
    onActivated: async (tx, prepared, attemptId) => {
      const [block] = await tx
        .select()
        .from(question_block)
        .where(eq(question_block.id, input.block.id))
        .for('update');
      const [session] = await tx
        .select()
        .from(learning_session)
        .where(eq(learning_session.id, input.block.ingestion_session_id));
      if (
        block?.status !== 'draft' ||
        block.version !== input.block.version ||
        session?.status !== 'extracted'
      )
        throw new ApiError('capture_superseded', 'block changed before capture activation', 409);
      const coarse = prepared.candidate.result.coarse_outcome;
      if (coarse === 'unsupported')
        throw new ApiError('capture_unresolved', 'capture requires review', 409);
      const record = await enrollCapturedBlock(tx, {
        questionId: captured.questionId,
        nativeAttemptEventId: attemptId,
        outcome: coarse === 'correct' ? 'success' : coarse === 'incorrect' ? 'failure' : 'partial',
        answerMd: input.block.wrong_answer_md ?? '',
        answerImageRefs: input.pageRefs,
        imageRefs: input.block.image_refs,
        knowledgeIds: captured.knowledgeIds,
        captureMode: input.pageRefs.length ? 'image' : 'text',
        sourceDocumentId: captured.sourceDocumentId,
        now: input.now,
        generatedBy: 'workflow_judge',
      });
      await tx
        .update(question)
        .set({ draft_status: 'active', updated_at: input.now })
        .where(eq(question.id, captured.questionId));
      const [updated] = await tx
        .update(question_block)
        .set({
          status: 'auto_enrolled',
          imported_question_id: captured.questionId,
          imported_attempt_event_id: attemptId,
          version: sql`${question_block.version} + 1`,
          updated_at: input.now,
        })
        .where(and(eq(question_block.id, block.id), eq(question_block.version, block.version)))
        .returning({ version: question_block.version });
      await writeQuestionBlockLifecycleEvent(tx, {
        blockId: block.id,
        op: 'set_status',
        status: 'auto_enrolled',
        importedQuestionId: captured.questionId,
        importedAttemptEventId: attemptId,
        nextVersion: updated.version,
        actorKind: 'agent',
        actorRef: 'workflow_judge',
        now: input.now,
      });
      enrolled = {
        block_id: block.id,
        question_id: captured.questionId,
        attempt_event_id: attemptId,
        record_id: record.recordId,
        knowledge_ids: captured.knowledgeIds,
        confidence: input.confidence,
      };
    },
  });
  return enrolled;
}
