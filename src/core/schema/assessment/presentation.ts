import { z } from 'zod';
import { isPublicSharedMaterial } from './materials';
import type { ResponseSpecT } from './response';
import type { ScoringBasisT } from './scoring';
import type { QuestionGroupStructureT } from './structure';

/** Blocks contain references only. Keys, executable markup and arbitrary props are forbidden. */
export const QuestionPresentation = z.strictObject({
  version: z.literal(1),
  layout: z.enum(['stack', 'passage_split']),
  blocks: z
    .array(
      z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('prompt'), part_id: z.string().min(1) }),
        z.strictObject({ kind: z.literal('material'), material_id: z.string().min(1) }),
        z.strictObject({
          kind: z.literal('response'),
          slot_id: z.string().min(1),
          scoring_unit_id: z.string().min(1),
        }),
      ]),
    )
    .min(1),
});
export type QuestionPresentationT = z.infer<typeof QuestionPresentation>;

export function validateQuestionPresentation(
  presentation: QuestionPresentationT,
  structure: QuestionGroupStructureT,
  spec: ResponseSpecT,
  basis: ScoringBasisT,
): string[] {
  QuestionPresentation.parse(presentation);
  const issues: string[] = [];
  const prompts = new Set<string>();
  const slots = new Set<string>();
  for (const block of presentation.blocks) {
    switch (block.kind) {
      case 'prompt':
        if (!structure.parts.some((p) => p.part_id === block.part_id))
          issues.push('unknown_presentation_part');
        prompts.add(block.part_id);
        break;
      case 'material':
        if (
          !structure.materials.some(
            (m) => m.material_id === block.material_id && isPublicSharedMaterial(m),
          )
        ) {
          issues.push('non_public_presentation_material');
        }
        break;
      case 'response': {
        const slot = spec.slots.find((s) => s.slot_id === block.slot_id);
        const unit = basis.units.find((u) => u.scoring_unit_id === block.scoring_unit_id);
        if (slot == null || unit == null || !unit.slot_refs.includes(block.slot_id)) {
          issues.push('presentation_unit_slot_mismatch');
        }
        if (slots.has(block.slot_id)) issues.push('duplicate_presentation_response');
        slots.add(block.slot_id);
        break;
      }
    }
  }
  for (const part of structure.parts)
    if (!prompts.has(part.part_id)) issues.push('missing_presentation_part');
  for (const slot of spec.slots) {
    if (slot.kind !== 'table' && !slots.has(slot.slot_id))
      issues.push('missing_presentation_response');
  }
  return issues;
}
