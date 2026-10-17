// YUK-1497 — renders a frozen presentation block tree (spec §1) against the issued public data and
// the page's draft envelopes. Page-independent: any practice page mounts it with the issuance DTO,
// its draft entries and an updater. Content blocks reuse the existing renderers (MathMarkdown,
// StimulusFigure); input blocks are the view-layer blocks in this folder. Branches referencing
// unissued parts were already pruned by the backend projection; a block whose slot is not in the
// issued spec renders nothing.
import type { ReactNode } from 'react';

import type { PublicMaterialViewT, PublicQuestionFaceT } from '@/core/schema/assessment/dto';
import {
  Presentation,
  type PresentationBlockT,
  type PresentationT,
} from '@/core/schema/assessment/presentation';
import type {
  BlankSlotT,
  ResponseSlotT,
  SelectSlotT,
  SlotResponseT,
} from '@/core/schema/assessment/response';
import {
  type EvidenceAttachment,
  evidenceKindFromMime,
} from '@/ui/components/response/response-types';
import { StimulusFigure } from '@/ui/components/response/StimulusFigure';
import { MathMarkdown } from '@/ui/lib/math-markdown';
import { UiNextRoot } from '@/ui-next/public';

import { BlankInputBlock } from './BlankInputBlock';
import { BreakTapBlock } from './BreakTapBlock';
import { CustomBlock } from './CustomBlock';
import { readBlank, readOpen, readSelect, writeBlank, writeOpen, writeSelect } from './envelope';
import { FreeAreaBlock } from './FreeAreaBlock';
import { MatchingColumnsBlock } from './MatchingColumnsBlock';
import { OptionListBlock } from './OptionListBlock';
import { OrderingBlock } from './OrderingBlock';

/** The public slice of the issuance the tree needs (PracticeIssuanceDto fields). */
export interface IssuedFaceData {
  faces: readonly PublicQuestionFaceT[];
  materials: readonly PublicMaterialViewT[];
  /** Issued slots as projected: pure-option items already in frozen order, rendered as-is. */
  slots: readonly ResponseSlotT[];
}

/**
 * The wire DTO carries `presentation` as opaque JSON. Parse it with the same schema the server
 * validated against; null means "render per slot instead" (old revisions, or a payload this
 * client cannot read).
 */
export function parsePresentation(raw: unknown): PresentationT | null {
  if (raw == null) return null;
  const parsed = Presentation.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export type EntriesUpdate = (prev: SlotResponseT[]) => SlotResponseT[];

export interface PresentationBlocksProps {
  presentation: PresentationT;
  issued: IssuedFaceData;
  /** Draft envelopes (ResponseSet.entries). */
  entries: readonly SlotResponseT[];
  /**
   * Receives an updater, not a value, so async edits (an upload finishing later) apply to the
   * latest draft rather than the one they started from. `immediate`: save now rather than after
   * the typing debounce (a sandboxed custom block may hang the tab right after answering).
   */
  onEntriesChange: (update: EntriesUpdate, opts?: { immediate?: boolean }) => void;
  /** Subject notation for MathMarkdown (server-resolved). */
  notation?: string | null;
  disabled?: boolean;
  submitted?: boolean;
  /** A submit is in flight: custom blocks stop taking answers until it settles. */
  submitting?: boolean;
  /** free_area uploads in flight, per slot; join into the page's submit gate. */
  onUploadingChange?: (slotId: string, uploading: boolean) => void;
  /**
   * free_area attachments without a full receipt, per slot. They cannot go into the envelope, so
   * the page holds them: they stay on screen and the page blocks submit while any remain.
   */
  unreceipted?: Readonly<Record<string, EvidenceAttachment[]>>;
  onUnreceiptedChange?: (slotId: string, attachments: EvidenceAttachment[]) => void;
  onPreview?: (assetId: string) => void;
  className?: string;
}

const KIND_NAME: Record<string, string> = {
  option_list: '选项',
  matching_columns: '配对',
  break_tap: '断句',
  ordering: '排序',
  blank_input: '填空',
  free_area: '作答区',
};

export function PresentationBlocks({
  presentation,
  issued,
  entries,
  onEntriesChange,
  notation = null,
  disabled,
  submitted,
  submitting,
  onUploadingChange,
  unreceipted,
  onUnreceiptedChange,
  onPreview,
  className,
}: PresentationBlocksProps) {
  const slotById = new Map(issued.slots.map((slot) => [slot.slot_id, slot] as const));
  const faceById = new Map(issued.faces.map((face) => [face.part_id, face] as const));
  const materialById = new Map(issued.materials.map((m) => [m.material_id, m] as const));
  const state = { disabled, submitted };

  // question_no as-is + placement.label + kind name, e.g. 「(2) ① 选项」 (spec §1.2.2). Slots that
  // would share a name (no number, no placement label) get their order, e.g. 「填空 1」「填空 2」.
  const prefixOf = (slot: ResponseSlotT) =>
    [faceById.get(slot.part_id)?.question_no ?? '', slot.placement?.label ?? '']
      .filter(Boolean)
      .join(' ');
  const twins = new Map<string, string[]>();
  for (const slot of issued.slots) {
    const key = `${prefixOf(slot)}|${slot.kind}`;
    twins.set(key, [...(twins.get(key) ?? []), slot.slot_id]);
  }
  const labelFor = (slot: ResponseSlotT, kind: string) => {
    const same = twins.get(`${prefixOf(slot)}|${slot.kind}`) ?? [];
    const order = same.length > 1 ? String(same.indexOf(slot.slot_id) + 1) : '';
    return [prefixOf(slot), KIND_NAME[kind] ?? '作答', order].filter(Boolean).join(' ');
  };

  const selectSlot = (slotId: string): SelectSlotT | null => {
    const slot = slotById.get(slotId);
    return slot?.kind === 'select' ? slot : null;
  };

  const onSelect = (slot: SelectSlotT) => (ids: string[]) =>
    onEntriesChange((prev) => writeSelect(prev, slot, ids));

  const renderBlock = (block: PresentationBlockT): ReactNode => {
    switch (block.kind) {
      case 'stack':
        return (
          <div key={block.block_id} className="un-blk-stack" data-gap={block.gap ?? 'md'}>
            {block.children.map(renderBlock)}
          </div>
        );
      case 'passage_layout': {
        const passage = materialById.get(block.material_ref);
        return (
          <div
            key={block.block_id}
            className="un-blk-passage"
            data-layout={block.layout}
            data-width={block.passage_width ?? 'balanced'}
          >
            <section className="un-blk-passage-text" aria-label="阅读材料">
              {passage ? renderMaterial(passage) : null}
            </section>
            <div className="un-blk-passage-questions">{block.children.map(renderBlock)}</div>
          </div>
        );
      }
      case 'text_math': {
        const face = block.part_ref ? faceById.get(block.part_ref) : undefined;
        const material = block.material_ref ? materialById.get(block.material_ref) : undefined;
        const source = face?.prompt_md ?? material?.content_md;
        if (source === undefined) return null;
        return (
          <MathMarkdown key={block.block_id} className="un-blk-text" notation={notation}>
            {source}
          </MathMarkdown>
        );
      }
      case 'figure': {
        const material = materialById.get(block.material_ref);
        if (!material) return null;
        return (
          <StimulusFigure
            key={block.block_id}
            assetId={material.asset_id}
            caption={material.caption}
            alt={material.alt_text}
          />
        );
      }
      case 'custom':
        return (
          <CustomBlock
            key={block.block_id}
            block={block}
            slotById={slotById}
            entries={entries}
            onEntriesChange={onEntriesChange}
            locked={!!(disabled || submitted || submitting)}
          />
        );
      case 'option_list': {
        const slot = selectSlot(block.bind.slot_id);
        if (!slot) return null;
        // The projection already serves pure-option items in the issuance's frozen order.
        return (
          <OptionListBlock
            key={block.block_id}
            label={labelFor(slot, block.kind)}
            items={slot.items.map((item) => ({ id: item.item_id, label_md: item.label_md ?? '' }))}
            pick={slot.pick}
            layout={block.layout}
            marker={block.marker}
            value={readSelect(entries, slot.slot_id)}
            onChange={onSelect(slot)}
            notation={notation}
            {...state}
          />
        );
      }
      case 'matching_columns': {
        const slot = selectSlot(block.bind.slot_id);
        if (!slot) return null;
        return (
          <MatchingColumnsBlock
            key={block.block_id}
            label={labelFor(slot, block.kind)}
            left={axis(slot, 'left')}
            right={axis(slot, 'right')}
            pairs={slot.items.flatMap((item) => {
              const left = item.coordinates?.left;
              const right = item.coordinates?.right;
              return left && right ? [{ id: item.item_id, left, right }] : [];
            })}
            atMost={{
              left: slot.at_most_per_coordinate?.left,
              right: slot.at_most_per_coordinate?.right,
            }}
            value={readSelect(entries, slot.slot_id)}
            onChange={onSelect(slot)}
            notation={notation}
            {...state}
          />
        );
      }
      case 'break_tap': {
        const slot = selectSlot(block.bind.slot_id);
        if (!slot || slot.text === undefined) return null;
        return (
          <BreakTapBlock
            key={block.block_id}
            label={labelFor(slot, block.kind)}
            text={slot.text}
            gaps={slot.items.flatMap((item) =>
              item.gap_after_codepoint !== undefined
                ? [{ id: item.item_id, at: item.gap_after_codepoint }]
                : [],
            )}
            value={readSelect(entries, slot.slot_id)}
            onChange={onSelect(slot)}
            {...state}
          />
        );
      }
      case 'ordering': {
        const slot = selectSlot(block.bind.slot_id);
        if (!slot) return null;
        return (
          <OrderingBlock
            key={block.block_id}
            label={labelFor(slot, block.kind)}
            positions={axis(slot, 'position')}
            objects={axis(slot, 'object')}
            placements={slot.items.flatMap((item) => {
              const position = item.coordinates?.position;
              const object = item.coordinates?.object;
              return position && object ? [{ id: item.item_id, position, object }] : [];
            })}
            atMost={{
              position: slot.at_most_per_coordinate?.position,
              object: slot.at_most_per_coordinate?.object,
            }}
            value={readSelect(entries, slot.slot_id)}
            onChange={onSelect(slot)}
            notation={notation}
            {...state}
          />
        );
      }
      case 'blank_input': {
        const slot = slotById.get(block.bind.slot_id);
        if (slot?.kind !== 'blank') return null;
        const blank: BlankSlotT = slot;
        return (
          <BlankInputBlock
            key={block.block_id}
            label={labelFor(blank, block.kind)}
            value={readBlank(entries, blank.slot_id)}
            onChange={(text) => onEntriesChange((prev) => writeBlank(prev, blank.slot_id, text))}
            width={block.width}
            unitHint={blank.unit_hint}
            maxChars={blank.max_chars}
            format={blank.format}
            notation={notation}
            {...state}
          />
        );
      }
      case 'free_area': {
        const slot = slotById.get(block.bind.slot_id);
        if (slot?.kind !== 'open_response') return null;
        const slotId = slot.slot_id;
        const open = readOpen(entries, slotId);
        const attachments: EvidenceAttachment[] = [
          ...open.evidence.map((original) => ({
            asset_id: original.asset.asset_id,
            original,
            kind: evidenceKindFromMime(original.mime_type),
            slot_ids: [slotId],
          })),
          ...(unreceipted?.[slotId] ?? []),
        ];
        return (
          <FreeAreaBlock
            key={block.block_id}
            label={labelFor(slot, block.kind)}
            text={open.text_md}
            onTextChange={(text_md) =>
              onEntriesChange((prev) =>
                writeOpen(prev, slotId, { text_md, evidence: readOpen(prev, slotId).evidence }),
              )
            }
            attachments={attachments}
            onAttachmentsChange={(next) => {
              onEntriesChange((prev) =>
                writeOpen(prev, slotId, {
                  text_md: readOpen(prev, slotId).text_md ?? '',
                  // Only uploads with a full receipt can go into an immutable submission.
                  evidence: next.flatMap((a) => (a.original ? [a.original] : [])),
                }),
              );
              // The rest stay with the page (shown, and blocking submit) instead of vanishing.
              onUnreceiptedChange?.(
                slotId,
                next.filter((a) => !a.original),
              );
            }}
            minLines={block.min_lines}
            notation={notation}
            onUploadingChange={(on) => onUploadingChange?.(slotId, on)}
            onPreview={onPreview}
            {...state}
          />
        );
      }
    }
  };

  const renderMaterial = (material: PublicMaterialViewT) =>
    material.content_md !== undefined ? (
      <MathMarkdown notation={notation}>{material.content_md}</MathMarkdown>
    ) : (
      <StimulusFigure
        assetId={material.asset_id}
        caption={material.caption}
        alt={material.alt_text}
      />
    );

  return (
    <UiNextRoot className={['un-blk-tree', className].filter(Boolean).join(' ')}>
      {renderBlock(presentation.root)}
    </UiNextRoot>
  );
}

function axis(slot: SelectSlotT, name: string) {
  return (slot.axes?.[name] ?? []).map((entry) => ({ id: entry.id, label_md: entry.label_md }));
}
