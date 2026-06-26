import { describe, expect, it } from 'vitest';
import tencentMathPage1 from '../../../../tests/fixtures/glm-ocr/tencent-math-page1.json';
import clozeFixture from '../../../../tests/fixtures/tencent_mark_agent_cloze_sample.json';
import {
  flat8ToBBox,
  parseMarkAgentResponse,
  parseStemMarkItemTitle,
  parseSubMarkItemTitle,
} from './tencent_mark_parser';

describe('flat8ToBBox', () => {
  it('converts 8-flat coords to 0-1 BBox', () => {
    const bbox = flat8ToBBox([77, 967, 1035, 967, 1035, 1015, 77, 1015], 1500, 2000);
    expect(bbox.x).toBeCloseTo(77 / 1500);
    expect(bbox.y).toBeCloseTo(967 / 2000);
    expect(bbox.width).toBeCloseTo((1035 - 77) / 1500);
    expect(bbox.height).toBeCloseTo((1015 - 967) / 2000);
  });

  it('clamps out-of-range to [0,1]', () => {
    const bbox = flat8ToBBox([-50, -50, 3000, -50, 3000, 3000, -50, 3000], 1500, 2000);
    expect(bbox.x).toBe(0);
    expect(bbox.y).toBe(0);
    expect(bbox.width).toBe(1);
    expect(bbox.height).toBe(1);
  });

  it('caps width/height so x+width and y+height never exceed 1 (overflow at x>0, YUK-471 W3-C1δ)', () => {
    // A near-edge box overflowing past the right/bottom: x≈0.933, y=0.95, raw w/h overflow the page.
    // The OLD independent clamp left width≈0.133 → x+width≈1.066, which FAILS the canonical BBox
    // refine (the create-event strict barrier). The sum-clamp (width ≤ 1-x) caps it.
    const bbox = flat8ToBBox([1400, 1900, 1600, 1900, 1600, 2100, 1400, 2100], 1500, 2000);
    expect(bbox.x).toBeCloseTo(1400 / 1500);
    expect(bbox.y).toBeCloseTo(1900 / 2000);
    expect(bbox.x + bbox.width).toBeLessThanOrEqual(1);
    expect(bbox.y + bbox.height).toBeLessThanOrEqual(1);
    expect(bbox.width).toBeCloseTo(1 - 1400 / 1500);
    expect(bbox.height).toBeCloseTo(1 - 1900 / 2000);
  });

  it('throws on wrong length', () => {
    expect(() => flat8ToBBox([1, 2, 3], 100, 100)).toThrow();
  });
});

describe('parseSubMarkItemTitle', () => {
  it('parses leading number + options', () => {
    const r = parseSubMarkItemTitle('1. ______\nA. decision\nB. reason\nC. difference\nD. choice');
    expect(r.question_no).toBe('1');
    expect(r.prompt_text).toBe('______');
    expect(r.options).toEqual([
      { label: 'A', text: 'decision' },
      { label: 'B', text: 'reason' },
      { label: 'C', text: 'difference' },
      { label: 'D', text: 'choice' },
    ]);
  });

  it('handles no question_no prefix', () => {
    const r = parseSubMarkItemTitle('What is the meaning of life?');
    expect(r.question_no).toBeUndefined();
    expect(r.prompt_text).toBe('What is the meaning of life?');
    expect(r.options).toEqual([]);
  });
});

describe('parseStemMarkItemTitle', () => {
  it('returns the entire title as prompt_text (no secondary parsing)', () => {
    const passage = 'Cloze Test\n1. ______ and 2. ______ are blanks.';
    const r = parseStemMarkItemTitle(passage);
    expect(r.prompt_text).toBe(passage);
  });
});

describe('parseMarkAgentResponse (cloze fixture)', () => {
  it('produces 1 stem + 7 sub questions with options/answers/evidence', () => {
    const result = parseMarkAgentResponse(clozeFixture, { pageWidth: 1500, pageHeight: 2000 });
    expect(result.questions).toHaveLength(1);
    const stem = result.questions[0];
    expect(stem.role).toBe('stem');
    expect(stem.sub_questions).toHaveLength(7);

    for (const sub of stem.sub_questions ?? []) {
      expect(sub.role).toBe('sub');
      expect(sub.options).toHaveLength(4);
      expect(sub.answers).toBeDefined();
      expect(sub.answers).toHaveLength(1);
      expect(sub.extraction_evidence?.handwriting).toBeDefined();
      expect(sub.extraction_evidence?.tencent_grading).toBeDefined();
      expect(sub.extraction_evidence?.tencent_grading?.KnowledgePoints).toBeDefined();
      expect(sub.bbox).toBeDefined();
      expect(sub.source).toBe('tencent_ocr');
    }
  });

  it('layout_quality = structured for the cloze sample (7 blanks ≈ 7 subs)', () => {
    const result = parseMarkAgentResponse(clozeFixture, { pageWidth: 1500, pageHeight: 2000 });
    expect(result.layout_quality).toBe('structured');
    expect(result.warnings).toEqual([]);
  });

  it('layout_quality = partial when stem has more blanks than subs', () => {
    // 合成 fixture：stem 文本里 10 个 "n. ___" 但 sub_questions 只 7 个
    const synthetic = JSON.parse(JSON.stringify(clozeFixture)) as typeof clozeFixture;
    const stem = synthetic.MarkInfos?.[0];
    if (stem) {
      stem.MarkItemTitle = '1. ___ 2. ___ 3. ___ 4. ___ 5. ___ 6. ___ 7. ___ 8. ___ 9. ___ 10. ___';
    }
    const result = parseMarkAgentResponse(synthetic, { pageWidth: 1500, pageHeight: 2000 });
    expect(result.layout_quality).toBe('partial');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('layout_quality = text_only when no sub questions', () => {
    const emptyRaw = { JobStatus: 'DONE', MarkInfos: [] };
    const result = parseMarkAgentResponse(emptyRaw, { pageWidth: 1500, pageHeight: 2000 });
    expect(result.questions).toHaveLength(0);
    expect(result.layout_quality).toBe('text_only');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('emits no figures when QuestionImagePositions is empty', () => {
    const result = parseMarkAgentResponse(clozeFixture, { pageWidth: 1500, pageHeight: 2000 });
    expect(result.figures).toEqual([]);
  });

  it('accepts Tencent figure positions in { Position: number[] } object form', () => {
    const result = parseMarkAgentResponse(tencentMathPage1, { pageWidth: 1241, pageHeight: 1754 });
    expect(result.figures).toHaveLength(1);
    expect(result.figures[0].source_page_index).toBe(0);
    expect(result.figures[0].bbox.x).toBeCloseTo(122 / 1241);
    expect(result.figures[0].bbox.y).toBeCloseTo(1392 / 1754);
    expect(result.figures[0].bbox.width).toBeCloseTo((381 - 122) / 1241);
    expect(result.figures[0].bbox.height).toBeCloseTo((1544 - 1392) / 1754);
  });
});
