import type { PaperDetail, PaperSlot } from '@/capabilities/practice/ui/practice-api';
import type { ResponseSlotT, SlotResponseT } from '@/core/schema/assessment';

/** UI-only transport fixture: preserve each scenario's content, draft and photo scope
 * while supplying the published response identities now required by the real component. */
export function nativePaperDetailFixture(detail: PaperDetail | null): PaperDetail | null {
  if (!detail) return detail;
  return {
    ...detail,
    sections: detail.sections.map((section) => ({
      ...section,
      slots: section.slots.map((slot): PaperSlot => {
        if (slot.assessment) return slot;
        const key = `${detail.artifact_id}:${slot.question_id}:${slot.part_ref ?? ''}`;
        const slotId = `response:${key}`;
        const options = (slot.question.choices_md ?? []).map((text, index) => ({
          option_id: `option:${key}:${index}`,
          label: String.fromCharCode(65 + index),
          text,
        }));
        const spec: ResponseSlotT = options.length
          ? { slot_id: slotId, part_id: slot.question_id, kind: 'single_choice', options }
          : { slot_id: slotId, part_id: slot.question_id, kind: 'text', math_preview: false };
        const original = slot.slot_state.submission;
        const draft = slot.slot_state.draft;
        const text = original?.answer_md ?? draft?.content_md ?? '';
        const response: SlotResponseT = options.length
          ? {
              slot_id: slotId,
              kind: 'choice',
              option_ids: options
                .filter((option) => option.text === text || option.label === text)
                .map((option) => option.option_id),
            }
          : { slot_id: slotId, kind: 'text', text_md: text };
        const images = original?.answer_image_refs ?? draft?.image_refs ?? [];
        return {
          ...slot,
          assessment: {
            issuance_id: `issuance:${key}`,
            evaluation_group_id: `group:${key}`,
            idempotency_key: `submission:${key}`,
            save_epoch: 0,
            practice_dto: {
              issuance_id: `issuance:${key}`,
              revision_id: `revision:${key}`,
              issued_at: '2026-10-04T00:00:00.000Z',
              faces: [
                { part_id: slot.question_id, prompt_md: slot.question.prompt_md, material_ids: [] },
              ],
              materials: [],
              response_spec: { slots: [spec] },
            },
            response_set: { entries: [response] },
            group_evidence: images.map((assetId) => ({
              target: { scope: 'all_units' as const },
              evidence: {
                evidence_id: `evidence:${assetId}`,
                kind: 'image' as const,
                asset: { asset_id: assetId, digest: `sha256:${'a'.repeat(64)}` },
                mime_type: 'image/png',
                bytes: 1024,
                uploaded_at: '2026-10-04T00:00:00.000Z',
              },
            })),
          },
        };
      }),
    })),
  };
}
