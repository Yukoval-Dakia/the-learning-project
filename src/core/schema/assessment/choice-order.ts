import type { PresentationT } from './presentation';
import type { ResponseSlotT, ResponseSpecT } from './response';
import type { ScoringBasisT } from './scoring';
import type { QuestionGroupStructureT } from './structure';

export function choiceLetter(index: number): string {
  return index < 26
    ? String.fromCharCode(65 + index)
    : `${String.fromCharCode(64 + Math.floor(index / 26))}${String.fromCharCode(65 + (index % 26))}`;
}

/** Remove only an option's own printed marker, including repeated OCR markers. */
export function choiceContent(text: string, label: string): string {
  if (!/^[A-Z]+$/.test(label)) return text;
  const prefix = new RegExp(`^\\s*(?:${label}[.．、:：]\\s*|[（(]${label}[)）]\\s*)`);
  const pair = new RegExp(`^\\s*${label}、\\s*[A-Za-z](?![A-Za-z])`);
  while (prefix.test(text) && !pair.test(text)) text = text.replace(prefix, '');
  return text;
}

export function isPlainChoice(slot: ResponseSlotT): boolean {
  return (
    slot.kind === 'single_choice' ||
    slot.kind === 'multi_choice' ||
    (slot.kind === 'select' &&
      slot.axes == null &&
      slot.text == null &&
      slot.items.every((item) => item.coordinates == null && item.gap_after_codepoint == null))
  );
}

// Deliberately conservative: a variable named A, an image, or unparsed markup
// can hide a positional dependency. Uncertain cases preserve the printed order.
const dependent =
  /以上|上述|前述|下述|上面|下面|全[部都不]|[均都皆].{0,4}(?:对|错|正确|错误|不是|不|是|非)|前[一两二三四五六七八九十几]|后[一两二三四五六七八九十几]|第[一二三四五六七八九十\d]+[个项]|[上下左右]侧|[①-⑳]|上記|下記|すべて|いずれも|どちらも|両方|\b(?:all|none|above|below|both|neither|former|latter|previous|preceding|following|first|second|third|fourth|last|left|right)\b|(?<![a-z])[a-z](?![a-z])|!\[|[<>]/iu;
const compactLetters = /(?<![A-Za-z])[A-Z]{2,4}(?![A-Za-z0-9])/;

/** Server publication owns this fact; producer-supplied markers are recomputed. */
export function classifyChoiceOrder(
  structure: QuestionGroupStructureT,
  spec: ResponseSpecT,
  presentation?: PresentationT,
  scoringBasis?: ScoringBasisT,
): ResponseSpecT {
  const context = [
    ...structure.parts.map((part) => part.prompt_md),
    ...(scoringBasis?.units ?? []).flatMap((unit) => {
      const criterion = unit.criterion;
      return [
        unit.rule?.source?.statement ?? '',
        ...(criterion.kind === 'rule_reference'
          ? [criterion.statement_md]
          : criterion.kind === 'holistic_level'
            ? criterion.levels.map((level) => level.descriptor_md)
            : criterion.kind === 'rubric'
              ? [
                  ...criterion.criteria.map((item) => item.statement_md),
                  criterion.reference_md ?? '',
                ]
              : []),
      ];
    }),
    ...structure.materials.map((material) =>
      // A bare canonical answer letter is projected from stable IDs after issue.
      material.visibility === 'private' &&
      /^sol_[0-9a-f]{12}$/.test(material.asset.asset_id) &&
      /^[A-Z](?:[\s,，、]*[A-Z])*$/.test(material.content_md?.trim() ?? '')
        ? ''
        : `${material.content_md ?? ''}\n${material.caption ?? ''}\n${material.alt_text ?? ''}`,
    ),
  ];
  const unknownVisual =
    structure.materials.some((material) => !['plaintext', 'passage'].includes(material.kind)) ||
    (presentation != null &&
      /"custom"|"marker":"(?:none|number)"/.test(JSON.stringify(presentation)));
  return {
    ...spec,
    slots: spec.slots.map((slot) => {
      if (!isPlainChoice(slot)) return slot;
      if (slot.kind !== 'single_choice' && slot.kind !== 'multi_choice' && slot.kind !== 'select')
        return slot;
      const texts =
        slot.kind === 'select'
          ? slot.items.map((item, index) => choiceContent(item.label_md ?? '', choiceLetter(index)))
          : slot.options.map((option) => choiceContent(option.text, option.label));
      const independent =
        !unknownVisual &&
        structure.parts.length === 1 &&
        spec.slots.length === 1 &&
        (slot.kind === 'select' ||
          slot.options.every((option, index) => option.label === choiceLetter(index))) &&
        texts.length >= 2 &&
        texts.every((text) => text.trim()) &&
        [...context, ...texts].every((text) =>
          [text, text.normalize('NFKC')].every(
            (content) => !dependent.test(content) && !compactLetters.test(content),
          ),
        );
      return { ...slot, choice_order: independent ? ('independent' as const) : ('fixed' as const) };
    }),
  };
}

/** Historical revisions stay immutable; absent facts are proved from frozen content. */
export function resolveChoiceOrder(
  structure: QuestionGroupStructureT,
  spec: ResponseSpecT,
  presentation?: PresentationT,
  scoringBasis?: ScoringBasisT,
): ResponseSpecT {
  const classified = classifyChoiceOrder(structure, spec, presentation, scoringBasis);
  return {
    ...spec,
    slots: spec.slots.map((slot, index) =>
      isPlainChoice(slot) && (!('choice_order' in slot) || slot.choice_order == null)
        ? classified.slots[index]
        : slot,
    ),
  };
}
