import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MistakeCard, type MistakeRow } from './MistakesPage';

vi.mock('@/ui/lib/assets', () => ({
  peekAssetObject: (id: string) => ({ url: `blob:fixture/${id}`, mimeType: 'image/png' }),
  fetchAssetObject: vi.fn(),
}));

function mistake(
  referenceMd: string | null,
  cause: MistakeRow['cause'] = {
    source: 'agent',
    primary_category: 'concept',
    primary_label: null,
    secondary_categories: [],
    secondary_labels: {},
    user_notes: null,
    confidence: 0.9,
  },
): MistakeRow {
  return {
    id: 'attempt_1',
    record_id: 'record_1',
    question_id: 'question_1',
    prompt_md: '“之”在主谓之间有什么作用？',
    prompt_materials: [],
    reference_md: referenceMd,
    wrong_answer_md: '代词',
    wrong_answer_image_refs: [],
    knowledge_ids: ['knowledge_1'],
    cause,
    correction_state: {
      original_event_id: 'attempt_1',
      state: 'active',
      terminal_state: 'active',
      effective_event_id: 'attempt_1',
      correction_event_id: null,
      replacement_event_id: null,
      chain: [
        {
          event_id: 'attempt_1',
          state: 'active',
          correction_event_id: null,
          replacement_event_id: null,
        },
      ],
    },
    created_at: 1_700_000_000,
  };
}

function renderMistake(referenceMd: string | null, cause?: MistakeRow['cause']): string {
  return renderToString(
    <MistakeCard
      m={cause === undefined ? mistake(referenceMd) : mistake(referenceMd, cause)}
      subject={null}
      subjectRows={[]}
      kpName={() => '主谓取消独立性'}
      navigate={vi.fn()}
    />,
  );
}

describe('MistakeCard reference answer comparison', () => {
  it('renders both the wrong answer and the available reference answer', () => {
    const html = renderMistake('取消句子独立性');

    expect(html).toContain('cmp-wrong');
    expect(html).toContain('代词');
    expect(html).toContain('cmp-right');
    expect(html).toContain('取消句子独立性');
    expect(html).toContain('>正<');
  });

  it.each([null, '', '   '])('omits the right-hand row when reference_md is %j', (value) => {
    const html = renderMistake(value);

    expect(html).toContain('cmp-wrong');
    expect(html).not.toContain('cmp-right');
    expect(html).not.toContain('>正<');
  });
});

describe('MistakeCard historical evidence', () => {
  it('renders the existing unavailable-question fallback while retaining the wrong answer', () => {
    const row = { ...mistake(null), prompt_md: '' };
    const html = renderToString(
      <MistakeCard
        m={row}
        subject={null}
        subjectRows={[]}
        kpName={() => '语法'}
        navigate={vi.fn()}
      />,
    );
    expect(html).toContain('（无题面）');
    expect(html).toContain('代词');
    expect(html).not.toContain('cmp-right');
    expect(html).toContain('查看事件链');
  });

  it('feeds original image refs to the existing attachment preview buttons', () => {
    const row = { ...mistake(null), wrong_answer_image_refs: ['answer_page_1', 'answer_page_2'] };
    const html = renderToString(
      <MistakeCard
        m={row}
        subject={null}
        subjectRows={[]}
        kpName={() => '语法'}
        navigate={vi.fn()}
      />,
    );
    expect(html).toContain('aria-label="已附证据"');
    expect(html).toContain('blob:fixture/answer_page_1');
    expect(html).toContain('blob:fixture/answer_page_2');
    expect(html).toContain('放大查看附件 1');
    expect(html).toContain('放大查看附件 2');
  });
});

// YUK-1020 — misc_ secondary id 显示回填经 CauseBadge：label 命中渲染 title，
// vocab / unresolvable 回退裸 id。
describe('MistakeCard secondary cause labels', () => {
  it('renders the misc_ secondary title and falls back to raw ids', () => {
    const html = renderMistake('ref', {
      source: 'agent',
      primary_category: 'concept',
      primary_label: null,
      secondary_categories: ['misc_sec_1', 'grammar', 'misc_sec_gone'],
      secondary_labels: { misc_sec_1: '虚词误判' },
      user_notes: null,
      confidence: 0.9,
    });

    // React SSR 在 `+` 与文本间插 `<!-- -->` 分隔符，故按文本内容断言。
    expect(html).toContain('虚词误判</span>');
    expect(html).toContain('grammar</span>');
    expect(html).toContain('misc_sec_gone</span>');
    // misc_sec_1 裸 id 不再渲染（被 title 替换）。
    expect(html).not.toContain('misc_sec_1');
  });

  it('renders raw misc_ id when secondary_labels has no matching label', () => {
    const html = renderMistake('ref', {
      source: 'agent',
      primary_category: 'concept',
      primary_label: null,
      secondary_categories: ['misc_sec_1'],
      secondary_labels: {},
      user_notes: null,
      confidence: 0.9,
    });

    expect(html).toContain('misc_sec_1</span>');
  });
});
