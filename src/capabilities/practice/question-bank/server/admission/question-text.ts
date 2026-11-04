// Checks only the public question. Repairs preserve the frozen original in the receipt.
import { isPublicSharedMaterial } from '@/core/schema/assessment/materials';
import type {
  AdmissionMarkingStateT,
  AdmissionRepairT,
} from '../../tasks/question-admission-adjudicate';
import type { QuestionAdmissionDefinition } from './contract';

const OPTION_LINE = /^[ \t]*([A-Z])[．.、:：)）][ \t]*/gm;
const compact = (text: string) => text.replace(/\s+/gu, ' ').trim();
const optionBody = (text: string, label: string) =>
  text.replace(new RegExp(`^\\s*${label}[．.、:：)）]\\s*`, 'u'), '');

const MARKS = [
  {
    kind: 'dot',
    name: '加点',
    reference: /加点(?:的)?(?:字|词|成语|部分|内容)/gu,
    combining: /[\p{L}\p{N}][\u0307\u0323]/u,
    tex: /\\(?:dot|ddot|underset)\s*\{/u,
  },
  {
    kind: 'underline',
    name: '(?:下[划画]线|[划画]线)',
    reference:
      /(?:下[划画]线|[划画]线)(?:的)?(?:字|词|句|部分|内容|处)|underlined\s+(?:word|phrase|sentence|part)/giu,
    combining: /[\p{L}\p{N}]\u0332/u,
    tex: /\\(?:underline|underbar)\s*\{/u,
  },
  {
    kind: 'wavy',
    name: '(?:波浪线|波纹线)',
    reference: /(?:波浪线|波纹线)(?:的)?(?:字|词|句|部分|内容|处)/gu,
    combining: /[\p{L}\p{N}]\u0330/u,
    tex: /\\utilde\s*\{/u,
  },
  {
    kind: 'emphasis',
    name: '着重号',
    reference: /(?:加|带|有)?着重号(?:的)?(?:字|词|句|部分|内容)|(?:字|词|句).{0,8}着重号/gu,
    combining: /[\p{L}\p{N}][\u0307\u0323]/u,
    tex: /\\underset\s*\{/u,
  },
  {
    kind: 'box',
    name: '(?:方框|框内|框中|框出)',
    reference: /方框(?:内|中|里|标出|中的|内的)|(?:框内|框中|框出)(?:的)?(?:字|词|句|部分|内容)/gu,
    combining: /[□▢┌┐└┘]/u,
    tex: /\\(?:boxed|fbox)\s*\{/u,
  },
  {
    kind: 'figure_annotation',
    name: '图(?:上|中)(?:的)?(?:标注|标记|标出)',
    reference: /图(?:上|中)(?:的)?(?:标注|标记|标出)/gu,
    combining: /\b\B/u,
    tex: /\b\B/u,
  },
] as const;

function textIdentifiesTarget(text: string, name: string): boolean {
  // A quotation elsewhere (e.g. a comparison word or a passage) does not identify the marked target.
  const target =
    '(?:的)?(?:字词|词语|成语|汉字|字|词|句子|句|部分|内容)?(?:是|为|即|指|[:：])?\\s*';
  return (
    new RegExp(`${name}${target}[“「『"][^”」』"\\n]+[”」』"]`, 'u').test(text) ||
    new RegExp(`[“「『"][^”」』"\\n]+[”」』"](?:[（(]${name}[）)]|(?:的)?${name})`, 'u').test(text)
  );
}

export function prepareAdmissionQuestionText(
  definition: QuestionAdmissionDefinition,
  mathRendered: boolean,
): {
  definition: QuestionAdmissionDefinition;
  markings: AdmissionMarkingStateT[];
  changes: {
    part_id: string;
    original_prompt_md: string;
    prompt_md: string;
    kind: 'duplicate_options';
  }[];
  repairs: { part_id: string; repair: AdmissionRepairT }[];
} {
  const changes: ReturnType<typeof prepareAdmissionQuestionText>['changes'] = [];
  const repairs: ReturnType<typeof prepareAdmissionQuestionText>['repairs'] = [];
  const markings: AdmissionMarkingStateT[] = [];
  const parts = definition.structure.parts.map((part) => {
    const slots = definition.response_spec.slots.filter((slot) => slot.part_id === part.part_id);
    const selections = slots.filter((slot) => slot.kind === 'select');
    let prompt = part.prompt_md;
    if (selections.length > 0) {
      const lines = [...prompt.matchAll(OPTION_LINE)];
      if (lines.length > 0) {
        const slot = selections[0];
        const first = lines[0].index;
        const prefix = prompt.slice(0, first).trimEnd();
        const exact =
          selections.length === 1 &&
          slot.items.length <= 26 &&
          lines.length === slot.items.length &&
          prefix.trim().length > 0 &&
          lines.every((line, index) => {
            const label = String.fromCharCode(65 + index);
            const body = prompt.slice(line.index + line[0].length, lines[index + 1]?.index).trim();
            const expected = slot.items[index].label_md;
            return (
              line[1] === label &&
              expected != null &&
              expected.trim().length > 0 &&
              compact(body) === compact(optionBody(expected, label))
            );
          });
        if (exact) {
          prompt = prefix;
          changes.push({
            part_id: part.part_id,
            original_prompt_md: part.prompt_md,
            prompt_md: prompt,
            kind: 'duplicate_options',
          });
        } else {
          repairs.push({
            part_id: part.part_id,
            repair: {
              repair_target: 'question_text',
              broken_part: 'options',
              defect: 'ambiguity',
              fix_hint_md:
                'Separate the stem from its options. The labeled text is not an exact, complete trailing copy of the declared options; do not guess which text to remove.',
            },
          });
        }
      }
    }
    const materials = definition.structure.materials.filter(
      (material) =>
        part.material_ids.includes(material.material_id) && isPublicSharedMaterial(material),
    );
    const text = [
      prompt,
      ...materials.map((material) => material.content_md ?? ''),
      ...selections.flatMap((slot) => slot.items.map((item) => item.label_md ?? '')),
    ].join('\n\n');
    // Raw HTML is not rendered by MathMarkdown. Code and image alt text cannot prove a visible mark.
    const visible = text.replace(
      /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`|<[^>]*>|!\[[^\]]*\]\([^)]*\)/gu,
      '',
    );
    const math = mathRendered
      ? [...visible.matchAll(/(?<!\\)\$\$?([^$]+)\$\$?|\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]/gu)]
          .map((m) => m[1] ?? m[2] ?? m[3])
          .join('\n')
      : '';
    const hasFigure =
      materials.some((material) => material.kind === 'figure') ||
      /!\[[^\]]*\]\([^)]*\)/u.test(text);
    for (const mark of MARKS) {
      const dependent = [...text.matchAll(mark.reference)].length > 0;
      if (!dependent && !new RegExp(mark.name, 'u').test(text)) continue;
      const identified = textIdentifiesTarget(visible, mark.name);
      const candidate =
        mark.combining.test(visible) ||
        mark.tex.test(math) ||
        hasFigure ||
        /(?:\*\*[^*\n]+\*\*|__[^_\n]+__)/u.test(visible);
      const status = identified
        ? 'text_identified'
        : candidate || !dependent
          ? 'candidate_present'
          : 'missing_referenced';
      markings.push({ part_id: part.part_id, marking: mark.kind, status });
      if (status === 'missing_referenced')
        repairs.push({
          part_id: part.part_id,
          repair: {
            repair_target: 'question_text',
            broken_part: 'question',
            defect: 'missing_marking',
            fix_hint_md: `The public question refers to ${mark.kind}, but no visible matching marking or explicit textual identification of its target is present. Preserve the required marking in the learner-visible question or name every target explicitly.`,
          },
        });
    }
    return { ...part, prompt_md: prompt };
  });
  return {
    definition: changes.length
      ? { ...definition, structure: { ...definition.structure, parts } }
      : definition,
    markings,
    changes,
    repairs,
  };
}
