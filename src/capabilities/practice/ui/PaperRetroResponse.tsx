// YUK-1593 — 已公开 assessment 的只读复盘：题面、作答与卷级证据全部读冻结的
// practice_dto / response_set / group_evidence，不回读可变题目、不自动揭示参考
// 答案、不从作答推断对错。判定缺失或 outcome 不可读时只作 UNKNOWN（caution），
// 不把已答稿当已判对错，也不把辨认不清的作答当空白或答错。

import type { PublicMaterialViewT } from '@/core/schema/assessment/dto';
import type { PresentationBlockT } from '@/core/schema/assessment/presentation';
import type { ResponseSlotT, SlotResponseT } from '@/core/schema/assessment/response';
import { AssetEvidencePreview } from '@/ui/components/response/AssetEvidencePreview';
import { AttachmentStrip } from '@/ui/components/response/AttachmentStrip';
import { ResponseSlotField, nativeSlotFieldSpec } from '@/ui/components/response/ResponseSlotField';
import type { CoarseOutcome } from '@/ui/components/response/response-types';
import {
  type EvidenceAttachment,
  evidenceKindFromMime,
  isSlotResponseAnswered,
  nativeResponseText,
  nativeResponseValue,
} from '@/ui/components/response/response-types';
import { MathMarkdown } from '@/ui/lib/math-markdown';
import { boundSlots } from './blocks/envelope';
import { PresentationBlocks, parsePresentation } from './blocks/PresentationBlocks';
import type { PaperSlot } from './practice-api';

type RetroAssessment = NonNullable<PaperSlot['assessment']>;

/** envelope 里 state 的复盘文案：'answered' 无文案（渲染内容本身）；unknown/blank 各有字样。 */
const ENTRY_STATE_COPY = {
  unknown: '（无法辨认）',
  blank: '（主动留白）',
} as const;

type EntryState = 'answered' | keyof typeof ENTRY_STATE_COPY | 'missing';

function entryState(entry: SlotResponseT | undefined): EntryState {
  if (entry === undefined) return 'missing';
  if ('state' in entry && (entry.state === 'unknown' || entry.state === 'blank'))
    return entry.state;
  return isSlotResponseAnswered(nativeResponseValue(entry)) ? 'answered' : 'missing';
}

// 非 answered 条目的如实回显：状态已知就写字样，否则按未作答；绝不替学习者补答。
function RawEntryState({ entry }: { entry: SlotResponseT }) {
  const copy =
    'state' in entry && entry.state !== 'answered' ? ENTRY_STATE_COPY[entry.state] : undefined;
  return <span className="pf-rq-none">{copy ?? '（未作答）'}</span>;
}

/**
 * P1-1 — 只有 text_math.part_ref 会渲染对应 face 的 prompt_md；其它块
 * （option_list/blank_input/free_area 等）只挂作答控件不带题面文字。
 * 收集树里实际引用到的 part_id，未引用的 issued face 在树外如实补显，
 * 一道 frozen 题面只显示一次（树内或树外，不双显）。
 */
function textMathPartRefs(presentation: { root: PresentationBlockT }): ReadonlySet<string> {
  const refs = new Set<string>();
  const walk = (block: PresentationBlockT): void => {
    if (block.kind === 'text_math' && block.part_ref != null) refs.add(block.part_ref);
    if ('children' in block) for (const child of block.children) walk(child);
  };
  walk(presentation.root);
  return refs;
}

function MaterialView({
  material,
  notation,
}: {
  material: PublicMaterialViewT;
  notation?: string | null;
}) {
  return material.content_md !== undefined ? (
    <MathMarkdown notation={notation}>{material.content_md}</MathMarkdown>
  ) : (
    <AssetEvidencePreview
      assetId={material.asset_id}
      label={material.caption ?? material.alt_text ?? '材料'}
      variant="inline"
    />
  );
}

/** 块树未绑定的原生槽逐槽回放：与作答页同一 spec→value 映射（nativeSlotFieldSpec/nativeResponseValue）。 */
function PerSlotResponses({
  assessment,
  bound,
  notation,
  releasedOutcome,
}: {
  assessment: RetroAssessment;
  bound: ReadonlySet<string>;
  notation?: string | null;
  releasedOutcome: CoarseOutcome | null;
}) {
  const entries = assessment.response_set.entries;
  return (
    <>
      {assessment.practice_dto.response_spec.slots.map((slot) => {
        if (bound.has(slot.slot_id)) return null;
        const spec = nativeSlotFieldSpec(slot);
        const entry = entries.find((item) => item.slot_id === slot.slot_id);
        const state = entryState(entry);
        if (!spec) {
          // 表外槽（table 容器等）：有可描述文本照录，否则如实状态/未作答。
          const text = state === 'answered' && entry ? nativeResponseText(entry, slot) : '';
          return (
            <div key={slot.slot_id} className="pf-rq-row">
              <span className="pf-rq-label">{slot.placement?.label ?? '作答'}</span>
              {state === 'answered' && text !== '' ? (
                <span>{text}</span>
              ) : state === 'missing' || (state === 'answered' && text === '') ? (
                <span className="pf-rq-none">（未作答）</span>
              ) : entry ? (
                <RawEntryState entry={entry} />
              ) : (
                <span className="pf-rq-none">（未作答）</span>
              )}
            </div>
          );
        }
        return (
          <div key={slot.slot_id} className="pf-rq-row">
            <span className="pf-rq-label">{slot.placement?.label ?? '作答'}</span>
            {state === 'answered' ? (
              <ResponseSlotField
                spec={spec}
                value={nativeResponseValue(entry)}
                onChange={() => {}}
                disabled
                notation={notation}
                feedback="graded"
                selectionOutcome={
                  // P1-2 — 只有权威已发布且确定对错的 outcome 才着色：correct →
                  // 对，incorrect / partial（部分得分是确定判定）→ 错选样式；
                  // unsupported / partial_unknown / 未发布 / 不可读都保持 null
                  // 中性，绝不让「未知」落成 not_correct 的红色错误样式。
                  releasedOutcome === 'correct'
                    ? 'correct'
                    : releasedOutcome === 'incorrect' || releasedOutcome === 'partial'
                      ? 'not_correct'
                      : null
                }
                ariaLabel={slot.placement?.label ?? '作答'}
              />
            ) : state === 'missing' ? (
              <span className="pf-rq-none">（未作答）</span>
            ) : entry ? (
              <RawEntryState entry={entry} />
            ) : (
              <span className="pf-rq-none">（未作答）</span>
            )}
          </div>
        );
      })}
    </>
  );
}

/** select/blank 槽无 presentation 时的只读回显：与 nativeResponseText 同口径逐条描述。 */
function UnboundEnvelopeResponses({
  assessment,
  bound,
}: {
  assessment: RetroAssessment;
  bound: ReadonlySet<string>;
}) {
  return (
    <>
      {assessment.practice_dto.response_spec.slots.map((slot: ResponseSlotT) => {
        if (bound.has(slot.slot_id)) return null;
        if (slot.kind !== 'select' && slot.kind !== 'blank') return null;
        const entry = assessment.response_set.entries.find((item) => item.slot_id === slot.slot_id);
        const state = entryState(entry);
        const text = state === 'answered' && entry ? nativeResponseText(entry, slot) : '';
        return (
          <div key={slot.slot_id} className="pf-rq-row">
            <span className="pf-rq-label">{slot.placement?.label ?? '作答'}</span>
            {state === 'answered' && text !== '' ? (
              <span>{text}</span>
            ) : entry ? (
              <RawEntryState entry={entry} />
            ) : (
              <span className="pf-rq-none">（未作答）</span>
            )}
          </div>
        );
      })}
    </>
  );
}

/**
 * 该 slot 的卷级证据：读自己 assessment.group_evidence（绑定目标已在这条记录里；
 * wire 在交卷时把它按 slot 展开，回放不再按 scoring unit 反解目标）。
 */
function groupEvidenceOf(assessment: RetroAssessment): EvidenceAttachment[] {
  return (assessment.group_evidence ?? []).map((item) => ({
    asset_id: item.evidence.asset.asset_id,
    original: item.evidence,
    originalTarget: item.target,
    kind: evidenceKindFromMime(item.evidence.mime_type),
    slot_ids: null,
  }));
}

export function PaperRetroResponse({
  slot,
  notation,
  releasedOutcome,
  onPreview,
}: {
  slot: PaperSlot;
  notation?: string | null;
  /** release 后的粗判定；null = 未 release / 不可读（UNKNOWN，不着对错色）。 */
  releasedOutcome: CoarseOutcome | null;
  onPreview: (assetId: string) => void;
}) {
  const assessment = slot.assessment;
  if (!assessment) return null;
  const dto = assessment.practice_dto;
  const presentation = parsePresentation(dto.presentation);
  const bound = new Set(presentation ? boundSlots(presentation).map((item) => item.slot_id) : []);
  // P1-1 — frozen face 至少可读一次：树里没被 text_math 引用的 issued face
  // 在「题面」行补显（presentation 为 null 时沿用原有的全量平铺）。
  const shownPartIds = presentation ? textMathPartRefs(presentation) : null;
  const unshownFaces = presentation
    ? dto.faces.filter((face) => !shownPartIds?.has(face.part_id))
    : dto.faces;
  const evidence = groupEvidenceOf(assessment);

  return (
    <div className="pf-rq-native">
      {dto.materials.map((material) => (
        <div key={material.material_id} className="pf-rq-row">
          <span className="pf-rq-label">材料</span>
          <MaterialView material={material} notation={notation} />
        </div>
      ))}
      {unshownFaces.map((face) => (
        <div key={face.part_id} className="pf-rq-row">
          <span className="pf-rq-label">题面</span>
          <MathMarkdown notation={notation} className="un-read">
            {face.prompt_md}
          </MathMarkdown>
        </div>
      ))}
      <div className="pf-rq-row">
        <span className="pf-rq-label">你的作答</span>
        <div className="pf-rq-native-body">
          {presentation ? (
            <PresentationBlocks
              presentation={presentation}
              issued={{
                faces: dto.faces,
                materials: dto.materials,
                slots: dto.response_spec.slots,
              }}
              entries={assessment.response_set.entries}
              onEntriesChange={() => {}}
              notation={notation}
              disabled
              submitted
              onPreview={onPreview}
            />
          ) : null}
          <PerSlotResponses
            assessment={assessment}
            bound={bound}
            notation={notation}
            releasedOutcome={releasedOutcome}
          />
          <UnboundEnvelopeResponses assessment={assessment} bound={bound} />
        </div>
      </div>
      {evidence.length > 0 && (
        <div className="pf-rq-row">
          <span className="pf-rq-label">作答附件</span>
          <AttachmentStrip attachments={evidence} onPreview={onPreview} />
        </div>
      )}
    </div>
  );
}
