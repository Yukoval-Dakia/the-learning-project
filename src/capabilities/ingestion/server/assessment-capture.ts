import { eq } from 'drizzle-orm';
import { canonicalHash } from '@/core/migration/canonical';
import type { ResponseSetT, ResponseSlotT, ScoringBasisT } from '@/core/schema/assessment';
import type {
  BBoxT,
  HandwritingRedMarkT,
  StructuredQuestionT,
} from '@/core/schema/structured_question';
import type { Db } from '@/db/client';
import { acquireLearningStateWriteLock } from '@/db/learning-state-lock';
import {
  learning_session,
  question,
  question_block,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { commitFormalAttempt, recordFormalAttemptCapture, saveSubmission } from '@/kernel/judge';
import type { DocumentUsage } from '@/kernel/read-models/usage-policy';
import { assessmentAttemptEventId } from '@/kernel/records/assessment-attempt-identity';
import { freezeImageEvidence } from '@/kernel/records/assessment-evidence';
import { issueCapturedAssessment } from '@/kernel/records/assessment-issuance';
import type { AutoEnrolledBlock } from './auto-enroll';
import { recordCapturedQuestion, settleCapturedBlock } from './capture/captured-question';
import { collectHandwritingLeaves } from './handwriting-trace';

type Block = typeof question_block.$inferSelect;

// Per-unit/per-blank capture from a photographed answer sheet.
//
// select resolves stable item ids, blank yields one text slot, free keeps image
// evidence, and unreadable input is explicitly unknown (never a fake zero). Red ink
// is classified by learner preference; post-correction never masquerades as an
// original answer. The flat single-slot fallback is unchanged.

/** Red-ink classification; defaults to post_correction, which never counts as an answer. */
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
  /** 学习者自己标的红笔勾叉（证据，不代替判分）。 */
  red_ink_mark?: HandwritingRedMarkT;
  /** 手写转写的位置/版本来源；缺省 = 旧路径没有位置证据。 */
  trace?: {
    source: 'handwriting_trace_v1';
    bbox: BBoxT;
    confidence?: number;
  };
  /** 为什么这条 capture 只能是 unknown；页面和片 5 靠它区分「没写」和「没读到」。 */
  reason?: string;
}

interface CaptureInput {
  block: Block;
  knowledgeIds: string[];
  difficulty: number;
  confidence: number;
  canEnroll: boolean;
  pageRefs: string[];
  now: Date;
  /** Session-level usage resolved once by the caller; the fallback costs a lookup. */
  docUsage?: DocumentUsage;
  /** 逐单元读取结果；缺省 = 旧 flat 路径（wrong_answer_md 单槽）。 */
  unit_captures?: CapturedUnitAnswer[];
  /** 学习者红笔偏好（缺省保守 post_correction）。 */
  red_ink_preference?: RedInkClassification;
  /** Enrollment markers written onto the created question (auto-enroll caller). */
  enrollmentMetadata?: Record<string, unknown>;
  /** Who originated this entry; evidence provenance only, never a grading decision. */
  generatedBy?: 'workflow_judge' | 'ingestion_capture';
}

interface UnitCaptureRecord {
  slot_id: string;
  entry_kind: string;
  state: 'answered' | 'blank' | 'unknown' | 'omitted';
  ink: RedInkClassification | null;
  /** 学习者红笔勾叉；只作作答证据，判分链不读本字段。 */
  red_ink_mark?: HandwritingRedMarkT;
  /** 转写版本与页内位置；证据可追溯，不作答案键。 */
  trace?: {
    source: 'handwriting_trace_v1';
    bbox: BBoxT;
    confidence?: number;
  };
  /** 非空时说明为什么这条不是 answered；不把失败写成 omitted。 */
  reason?: string;
}

/** 红笔归类：观测到红笔才分类；post_correction 内容不计入作答。 */
function classifyInk(
  capture: CapturedUnitAnswer | undefined,
  preference: RedInkClassification | undefined,
): RedInkClassification | null {
  if (capture?.red_ink_observed !== true) return null;
  return preference ?? 'post_correction';
}

/** 叶题上的红笔勾/叉合并；同题勾叉都有 → mixed。 */
function mergeRedMarks(
  traces: ReadonlyArray<{ red_ink?: HandwritingRedMarkT }>,
): HandwritingRedMarkT | undefined {
  const marks = new Set(traces.map((trace) => trace.red_ink).filter(Boolean));
  if (marks.size === 0) return undefined;
  if (marks.has('mixed') || (marks.has('check') && marks.has('cross'))) return 'mixed';
  return marks.has('check') ? 'check' : 'cross';
}

export interface LeafHandwritingCapture {
  leaf_id: string;
  capture: CapturedUnitAnswer;
}

/**
 * 把每个叶题上的手写证据转成逐题捕获。只读 `extraction_evidence.handwriting`，
 * 不读题面/答案字段；容器题（stem）的手写不归属到任何 leaf，避免串题。
 */
function collectHandwritingCaptures(
  structured: StructuredQuestionT | null,
): LeafHandwritingCapture[] {
  if (!structured) return [];
  // A failed pass is not "no handwriting": every leaf gets an explicit unknown
  // so the capture never records `omitted` for a page whose trace never ran.
  if (structured.extraction_evidence?.handwriting_trace?.status === 'failed') {
    return collectHandwritingLeaves([structured]).map(({ node }) => ({
      leaf_id: node.id,
      capture: { state: 'unknown', reason: 'handwriting_trace_failed' },
    }));
  }
  const out: LeafHandwritingCapture[] = [];
  const walk = (node: StructuredQuestionT) => {
    const subs = node.sub_questions ?? [];
    if (subs.length > 0) {
      for (const sub of subs) walk(sub);
      return;
    }
    const traces = node.extraction_evidence?.handwriting ?? [];
    const text = traces
      .map((trace) => trace.text.trim())
      .filter((value) => value.length > 0)
      .join('\n');
    const redMark = mergeRedMarks(traces);
    const redText = traces.some((trace) => trace.red_text === true);
    const located = traces.find(
      (trace) => trace.bbox !== undefined && trace.bbox.width > 0 && trace.bbox.height > 0,
    );
    if (text.length > 0 || redMark !== undefined || redText) {
      out.push({
        leaf_id: node.id,
        capture: {
          state: text.length > 0 ? 'answered' : 'unknown',
          ...(text.length > 0 ? { text } : {}),
          ...(redText ? { red_ink_observed: true } : {}),
          ...(redMark !== undefined ? { red_ink_mark: redMark } : {}),
          ...(located?.bbox !== undefined
            ? {
                trace: {
                  source: 'handwriting_trace_v1' as const,
                  bbox: located.bbox,
                  ...(located.confidence !== undefined ? { confidence: located.confidence } : {}),
                },
              }
            : {}),
        },
      });
      return;
    }
    if (node.student_answer_present === true) {
      // 结构看到手写，但没有可归属的文本：显式 unknown，不冒充空白。
      out.push({ leaf_id: node.id, capture: { state: 'unknown' } });
    }
  };
  walk(structured);
  return out;
}

/** 任意节点报告了学生手写（容器手写也算，只是不归属到 leaf）。 */
function hasStudentWorkSignal(structured: StructuredQuestionT | null): boolean {
  if (!structured) return false;
  const stack: StructuredQuestionT[] = [structured];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.student_answer_present === true) return true;
    if ((node.extraction_evidence?.handwriting?.length ?? 0) > 0) return true;
    for (const sub of node.sub_questions ?? []) stack.push(sub);
  }
  return false;
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
    ctx.records.push({
      slot_id: slot.slot_id,
      entry_kind,
      state,
      ink,
      ...(capture?.red_ink_mark !== undefined ? { red_ink_mark: capture.red_ink_mark } : {}),
      ...(capture?.trace !== undefined ? { trace: capture.trace } : {}),
      ...(capture?.reason !== undefined ? { reason: capture.reason } : {}),
    });
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
        } else if (capture?.text != null && capture.text.trim().length > 0) {
          // 手写捕获可能只给了 "B" / "BD"；按标签解析，与 flat 回退同语义。
          const labels = capture.text
            .trim()
            .toUpperCase()
            .split(/[\s,，、]+/)
            .filter(Boolean);
          const resolved = resolveSelectLabels(slot, labels);
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
    // 旧槽位没有 unknown 响应态；但证据层仍需如实记未知，不能写成 omitted。
    record('unknown', `${slot.kind}:unknown`);
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
    // 逐单元捕获也是 capture 身份的一部分 —— 同一块不同的 per-unit
    // 读数不得复用旧 capture（capture_conflict 如实冲突）。仅当调用方真的
    // 传入才进 digest（缺席时键整体省略，旧 capture 的 digest 逐字节一致）。
    ...(input.unit_captures != null ? { unit_captures: input.unit_captures } : {}),
    ...(input.red_ink_preference != null ? { red_ink_preference: input.red_ink_preference } : {}),
  });
  return db.transaction(async (tx) => {
    await acquireLearningStateWriteLock(tx);
    // Same default as the attempt record's generated_by below.
    const generatedBy = input.generatedBy ?? 'workflow_judge';
    const [current] = await tx
      .select()
      .from(question_block)
      .where(eq(question_block.id, block.id))
      .for('update');
    const [session] = await tx
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, block.ingestion_session_id));
    // A degraded page layout ('partial') is a block-level fact: captured work on a
    // structurally usable block still gets its private evidence (YUK-1994).
    if (
      current?.status !== 'draft' ||
      current.version !== block.version ||
      session?.type !== 'ingestion' ||
      (session.status !== 'extracted' && session.status !== 'partial')
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
      await recordCapturedQuestion(tx, {
        questionId,
        sessionId: session.id,
        blockId: block.id,
        sourceDocumentId: session.source_document_id,
        source: session.entrypoint ?? 'vision_paper',
        content: { from: 'block', block },
        knowledgeIds: input.knowledgeIds,
        difficulty: input.difficulty,
        draftStatus: 'draft',
        extraMetadata: {
          capture_block_version: block.version,
          capture_input_digest: sourceDigest,
          source_asset_ids: block.source_asset_ids,
          // The judge blob asserts that a WorkflowJudge actually ran; a manual or
          // rescue capture never ran one, so it carries no confidence signal at all.
          ...(generatedBy === 'workflow_judge'
            ? {
                workflow_judge: {
                  confidence: input.confidence,
                  extraction_confidence: block.extraction_confidence,
                },
              }
            : {}),
          ...(input.enrollmentMetadata !== undefined
            ? { ingestion_enrollment: input.enrollmentMetadata }
            : {}),
        },
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
    // 逐题手写证据来自抽取阶段写进 structured 的 extraction_evidence。按 leaf
    // (= part) 定位槽：一叶一槽才落文本；一叶多槽属于跨槽不确定，只记 unknown，
    // 不把一段手写分给多个槽（不串题）。
    const slotsByPart = new Map<string, string[]>();
    for (const slot of slots) {
      const list = slotsByPart.get(slot.part_id) ?? [];
      list.push(slot.slot_id);
      slotsByPart.set(slot.part_id, list);
    }
    const warnings: string[] = [];
    for (const { leaf_id, capture } of collectHandwritingCaptures(current.structured)) {
      const partSlots = slotsByPart.get(leaf_id) ?? [];
      if (partSlots.length === 1) {
        const slotId = partSlots[0];
        if (slotId != null && !captureBySlot.has(slotId)) captureBySlot.set(slotId, capture);
      } else if (partSlots.length > 1) {
        for (const slotId of partSlots) {
          if (!captureBySlot.has(slotId)) {
            captureBySlot.set(slotId, {
              state: 'unknown',
              reason: 'handwriting_slot_ambiguous',
              ...(capture.red_ink_mark !== undefined ? { red_ink_mark: capture.red_ink_mark } : {}),
            });
          }
        }
      } else {
        // A leaf with no response slot cannot carry its handwriting. Dropping it
        // silently would look like "no handwriting" on the page, so leave a
        // warning with the block/leaf identity.
        warnings.push(
          `handwriting evidence for leaf ${leaf_id} dropped: no response slot in block ${block.id}`,
        );
      }
    }
    // 容器（stem）报告了手写但没有可归属的叶题证据：整组槽显式 unknown，
    // 不用空白或猜测填充。
    if (captureBySlot.size === 0 && hasStudentWorkSignal(current.structured)) {
      for (const slot of slots) captureBySlot.set(slot.slot_id, { state: 'unknown' });
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
    // Legacy flat response: keep the extracted text when present, else the
    // per-question handwriting transcript. This is learner evidence, never a key.
    const capturedResponseMd = entries
      .flatMap((entry) => (entry.kind === 'text' || entry.kind === 'open' ? [entry.text_md] : []))
      .filter((value) => value.trim().length > 0)
      .join('\n');
    await recordFormalAttemptCapture(tx, 'ingestion_grading', questionId, saved.submission, null, {
      response_md: text.trim().length > 0 ? text : capturedResponseMd,
      session_id: session.id,
      ingestion: {
        block_id: block.id,
        block_version: block.version,
        source_document_id: session.source_document_id ?? '',
        source_asset_ids: block.source_asset_ids,
        generated_by: generatedBy,
        // 逐单元读入的落位/未决与红笔归类留痕（不判分）。
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
      attemptEventId: assessmentAttemptEventId(saved.submission.submission_id),
      sourceDocumentId: session.source_document_id ?? '',
      knowledgeIds: existing?.knowledge_ids ?? input.knowledgeIds,
      admitted: lifecycle.scoring_admission_state === 'admitted',
      warnings,
    };
  });
}

export async function enrollNativeCapture(
  db: Db,
  input: CaptureInput,
): Promise<AutoEnrolledBlock | null> {
  // Deliberately retained: this is the only admission-gated commit path for a
  // captured original. Slice 5 (grading) consumes it; deleting it would move the
  // same logic there and drop the revert/withdrawal coverage below. It is NOT the
  // production auto-enroll path — that one captures evidence without grading.
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
      const record = await settleCapturedBlock(tx, {
        transition: 'auto_enroll',
        blockId: block.id,
        guard: { kind: 'version_cas', version: block.version },
        enroll: {
          questionId: captured.questionId,
          nativeAttemptEventId: attemptId,
          outcome:
            coarse === 'correct' ? 'success' : coarse === 'incorrect' ? 'failure' : 'partial',
          answerMd: input.block.wrong_answer_md ?? '',
          answerImageRefs: input.pageRefs,
          imageRefs: input.block.image_refs,
          knowledgeIds: captured.knowledgeIds,
          captureMode: input.pageRefs.length ? 'image' : 'text',
          sourceDocumentId: captured.sourceDocumentId,
          docUsage: input.docUsage,
          now: input.now,
          generatedBy: 'workflow_judge',
        },
      });
      await tx
        .update(question)
        .set({ draft_status: 'active', updated_at: input.now })
        .where(eq(question.id, captured.questionId));
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
