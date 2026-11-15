import { useId, useRef } from 'react';
import type { PracticeIssuanceDtoT } from '@/core/schema/assessment/dto';
import type { PresentationBlockT } from '@/core/schema/assessment/presentation';
import type { ResponseSlotT } from '@/core/schema/assessment/response';
import { ResponseSlotField, nativeSlotFieldSpec } from '@/ui/components/response/ResponseSlotField';
import { StimulusFigure } from '@/ui/components/response/StimulusFigure';
import { MathMarkdown } from '@/ui/lib/math-markdown';
import { Button } from '@/ui-next/public';
import { BlankInputBlock } from './blocks/BlankInputBlock';
import { boundSlots } from './blocks/envelope';
import { OptionListBlock } from './blocks/OptionListBlock';
import { PresentationBlocks, parsePresentation } from './blocks/PresentationBlocks';
import type { PaperDetail } from './practice-api';
import './paper-print.css';

type PaperPrintSource = Pick<PaperDetail, 'title' | 'sections'> &
  Pick<
    import('zod').infer<typeof import('../api/paper-contracts').PaperDetailResponseSchema>,
    'withheld_assessments'
  >;

type PrintablePaper = {
  title: string;
  sections: Array<{ section_index: number; questions: PracticeIssuanceDtoT[] }>;
};

function printableBlocks(block: PresentationBlockT, parts: Set<string>): boolean {
  if (block.kind === 'custom') return false;
  if (block.kind === 'text_math' && block.part_ref) parts.add(block.part_ref);
  return block.kind !== 'stack' && block.kind !== 'passage_layout'
    ? true
    : block.children.every((child) => printableBlocks(child, parts));
}

function extraSlots(dto: PracticeIssuanceDtoT) {
  const presentation = parsePresentation(dto.presentation);
  const drawn = new Set(
    presentation
      ? boundSlots(presentation).map((slot) => `${slot.slot_id}|${slot.response_class}`)
      : [],
  );
  return dto.response_spec.slots.filter((slot) => !drawn.has(`${slot.slot_id}|${slot.kind}`));
}

function hasPrintField(slot: ResponseSlotT): boolean {
  return (
    nativeSlotFieldSpec(slot) !== null ||
    slot.kind === 'blank' ||
    (slot.kind === 'select' &&
      slot.axes === undefined &&
      slot.items.every(
        (item) => item.label_md !== undefined && item.gap_after_codepoint === undefined,
      ))
  );
}

function preparePaper(paper: PaperPrintSource): {
  paper: PrintablePaper | null;
  reason: string | null;
} {
  if (paper.withheld_assessments?.length) {
    return { paper: null, reason: '这份卷有暂不可读取的题目，暂不能完整打印。' };
  }
  const sections: PrintablePaper['sections'] = [];
  for (const section of paper.sections) {
    const questions: PracticeIssuanceDtoT[] = [];
    for (const slot of section.slots) {
      const dto = slot.assessment?.practice_dto;
      if (!dto) {
        return { paper: null, reason: '这份历史卷没有完整冻结题面，暂不能打印。' };
      }
      const presentation = parsePresentation(dto.presentation);
      const parts = new Set<string>();
      if (
        (dto.presentation !== undefined && !presentation) ||
        (presentation &&
          (!printableBlocks(presentation.root, parts) ||
            dto.faces.some((face) => !parts.has(face.part_id)))) ||
        dto.materials.some(
          (material) =>
            material.kind !== 'figure' &&
            (!['passage', 'table', 'plaintext'].includes(material.kind) ||
              material.content_md === undefined),
        ) ||
        extraSlots(dto).some((field) => !hasPrintField(field))
      ) {
        return { paper: null, reason: '这份卷含暂不支持纸面呈现的题目或材料，暂不能完整打印。' };
      }
      questions.push(dto);
    }
    sections.push({ section_index: section.section_index, questions });
  }
  return sections.some((section) => section.questions.length > 0)
    ? { paper: { title: paper.title, sections }, reason: null }
    : { paper: null, reason: '这份卷没有可打印的冻结题面。' };
}

function PrintField({ slot }: { slot: ResponseSlotT }) {
  const label = slot.placement?.label ?? '作答';
  if (slot.kind === 'matching') {
    return (
      <div className="pf-paper-print-match">
        <div>
          {slot.left_items.map((item) => (
            <MathMarkdown key={item.item_id}>{`${item.label} ${item.text}`}</MathMarkdown>
          ))}
        </div>
        <div>
          {slot.right_options.map((option) => (
            <MathMarkdown key={option.option_id}>{`${option.label} ${option.text}`}</MathMarkdown>
          ))}
        </div>
      </div>
    );
  }
  if (slot.kind === 'ordering') {
    return (
      <div>
        {slot.items.map((item) => (
          <MathMarkdown key={item.item_id}>{`${item.label} ${item.text}`}</MathMarkdown>
        ))}
        <div className="pf-paper-print-writing" aria-label={label} />
      </div>
    );
  }
  const spec = nativeSlotFieldSpec(slot);
  if (spec) {
    return (
      <div>
        <ResponseSlotField
          spec={spec}
          label={label}
          value={undefined}
          onChange={() => {}}
          disabled
        />
        {slot.kind === 'numeric' && slot.unit_hint && <p>{slot.unit_hint}</p>}
      </div>
    );
  }
  if (slot.kind === 'blank') {
    return (
      <BlankInputBlock
        label={label}
        value=""
        onChange={() => {}}
        width="lg"
        format={slot.format}
        maxChars={slot.max_chars}
        unitHint={slot.unit_hint}
        disabled
      />
    );
  }
  if (slot.kind === 'select') {
    return (
      <div>
        {slot.text !== undefined && <MathMarkdown>{slot.text}</MathMarkdown>}
        <OptionListBlock
          label={label}
          items={slot.items.map((item) => ({ id: item.item_id, label_md: item.label_md ?? '' }))}
          pick={slot.pick}
          value={[]}
          onChange={() => {}}
          disabled
        />
      </div>
    );
  }
  return null;
}

function PrintQuestion({ dto }: { dto: PracticeIssuanceDtoT }) {
  const presentation = parsePresentation(dto.presentation);
  const bindings = presentation ? boundSlots(presentation) : [];
  return (
    <>
      {dto.response_spec.slots.map((slot) =>
        slot.kind === 'select' &&
        slot.text !== undefined &&
        bindings.some((binding) => binding.slot_id === slot.slot_id) &&
        !bindings.some(
          (binding) => binding.slot_id === slot.slot_id && binding.kind === 'break_tap',
        ) ? (
          <MathMarkdown key={slot.slot_id}>{slot.text}</MathMarkdown>
        ) : null,
      )}
      {presentation ? (
        <PresentationBlocks
          presentation={presentation}
          issued={{ faces: dto.faces, materials: dto.materials, slots: dto.response_spec.slots }}
          entries={[]}
          onEntriesChange={() => {}}
          disabled
        />
      ) : (
        <>
          {dto.materials.map((material) =>
            material.content_md !== undefined ? (
              <MathMarkdown key={material.material_id}>{material.content_md}</MathMarkdown>
            ) : (
              <StimulusFigure
                key={material.material_id}
                assetId={material.asset_id}
                caption={material.caption}
                alt={material.alt_text}
                containsLearnerHandwriting={material.contains_learner_handwriting}
                zoomable={false}
              />
            ),
          )}
          {dto.faces.map((face) => (
            <div key={face.part_id}>
              {face.question_no && <p>{face.question_no}</p>}
              <MathMarkdown>{face.prompt_md}</MathMarkdown>
            </div>
          ))}
        </>
      )}
      {extraSlots(dto).map((slot) => (
        <PrintField key={slot.slot_id} slot={slot} />
      ))}
    </>
  );
}

export function PaperPrintView({
  paper,
  onUnavailable,
}: {
  paper: PaperPrintSource;
  onUnavailable: (message: string) => void;
}) {
  const prepared = preparePaper(paper);
  const output = useRef<HTMLDivElement>(null);
  const reasonId = useId();
  return (
    <>
      <div className="pf-paper-print-action">
        <Button
          variant="secondary"
          disabled={!prepared.paper}
          aria-describedby={prepared.reason ? reasonId : undefined}
          onClick={() => {
            const root = output.current;
            if (
              !prepared.paper ||
              !root ||
              root.querySelector(
                '.rs-ev-pending, .un-math-wait, [aria-busy="true"], [data-asset-error]',
              ) ||
              document.fonts.status === 'loading' ||
              [...root.querySelectorAll('img')].some(
                (image) => !image.complete || image.naturalWidth === 0,
              )
            ) {
              onUnavailable('题面或题图尚未完整加载，请稍后再打印。');
              return;
            }
            window.print();
          }}
        >
          打印题目
        </Button>
        {prepared.reason && <p id={reasonId}>{prepared.reason}</p>}
      </div>
      {/* Reused input views create their own React IDs and receive only empty envelopes. */}
      <div ref={output} className="pf-paper-print">
        {prepared.paper ? (
          <>
            <h1>{prepared.paper.title}</h1>
            {prepared.paper.sections.map((section) => (
              <section key={section.section_index} className="pf-paper-print-section">
                {section.questions.map((dto, index) => (
                  <article key={dto.issuance_id} className="pf-paper-print-question">
                    <h2>
                      第 {section.section_index + 1} 部分 · 第 {index + 1} 题
                    </h2>
                    <PrintQuestion dto={dto} />
                  </article>
                ))}
              </section>
            ))}
          </>
        ) : (
          <p>{prepared.reason}</p>
        )}
      </div>
    </>
  );
}
