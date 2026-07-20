import { describe, expect, it } from 'vitest';
import { type SlimSubjectProfile, resolveSubjectRenderModel, subjectContentProps } from './subject';

const baseProfile: SlimSubjectProfile = {
  id: 'yuwen',
  displayName: '语文',
  renderConfig: {
    font_family: 'serif-cjk',
    notation: null,
    code_highlight: null,
  },
};

describe('resolveSubjectRenderModel', () => {
  it('maps serif-cjk content to the wenyan font token', () => {
    const model = resolveSubjectRenderModel(baseProfile);

    expect(model.id).toBe('yuwen');
    expect(model.displayName).toBe('语文');
    expect(model.contentClassName).toContain('subject-content');
    expect(model.contentClassName).toContain('subject-content--font-serif-cjk');
    expect(model.contentStyle.fontFamily).toBe('var(--font-wenyan)');
  });

  it('maps system content to the sans font token', () => {
    const model = resolveSubjectRenderModel({
      ...baseProfile,
      id: 'math',
      displayName: '数学',
      renderConfig: { ...baseProfile.renderConfig, font_family: 'system' },
    });

    expect(model.id).toBe('math');
    expect(model.contentClassName).toContain('subject-content--font-system');
    expect(model.contentStyle.fontFamily).toBe('var(--font-sans)');
  });

  it('falls back to the neutral general profile when profile is null', () => {
    // YUK (wenyan deprotagonist): the slim default is subject-neutral (general,
    // system font) — null content no longer inherits wenyan's serif-CJK.
    const model = resolveSubjectRenderModel(null);

    expect(model.id).toBe('general');
    expect(model.displayName).toBe('通用');
    expect(model.renderConfig.font_family).toBe('system');
    expect(model.contentStyle.fontFamily).toBe('var(--font-sans)');
  });

  it('falls back to sans font for unknown font families', () => {
    const model = resolveSubjectRenderModel({
      ...baseProfile,
      renderConfig: { ...baseProfile.renderConfig, font_family: 'specialist-font' },
    });

    expect(model.contentClassName).toContain('subject-content--font-unknown');
    expect(model.contentStyle.fontFamily).toBe('var(--font-sans)');
  });

  it('exposes a KaTeX notation hook without rendering formulas', () => {
    const model = resolveSubjectRenderModel({
      ...baseProfile,
      id: 'math',
      displayName: '数学',
      renderConfig: { font_family: 'system', notation: 'katex', code_highlight: null },
    });
    const props = subjectContentProps(model);

    expect(model.contentClassName).toContain('subject-content--notation-katex');
    expect(props.className).toBe(model.contentClassName);
    expect(props['data-subject']).toBe('math');
    expect(props['data-notation']).toBe('katex');
  });

  it('merges component className and style with subject content props', () => {
    const props = subjectContentProps(baseProfile, {
      className: 'qbody',
      style: { whiteSpace: 'pre-wrap' },
    });

    expect(props.className).toContain('qbody');
    expect(props.className).toContain('subject-content--font-serif-cjk');
    expect(props.style).toEqual({
      whiteSpace: 'pre-wrap',
      fontFamily: 'var(--font-wenyan)',
    });
  });

  it('keeps subject font when caller options include a legacy fontFamily', () => {
    const props = subjectContentProps(
      {
        ...baseProfile,
        id: 'math',
        displayName: '数学',
        renderConfig: { font_family: 'system', notation: null, code_highlight: null },
      },
      {
        className: 'qbody',
        style: { fontFamily: 'var(--font-serif)', whiteSpace: 'pre-wrap' },
      },
    );

    expect(props.className.endsWith('qbody')).toBe(true);
    expect(props.className.startsWith('subject-content')).toBe(true);
    expect(props.style.fontFamily).toBe('var(--font-sans)');
    expect(props.style.whiteSpace).toBe('pre-wrap');
  });
});

// YUK-598（review-757 P2-2 可测半）— rows 参数语义：provider 行驱动 vs 编译期回退。
describe('listSubjectChoices / subjectDisplayName rows 语义', async () => {
  const { listSubjectChoices, subjectDisplayName, subjectIdentityKey } = await import('./subject');
  const rows = [
    { id: 'yuwen', displayName: '语文', aliases: ['wenyan'] },
    {
      id: 'subj_chem1',
      displayName: '化学',
      aliases: ['huaxue'],
      configurationStatus: 'general-fallback' as const,
    },
    {
      id: 'yingyu',
      displayName: 'yingyu',
      aliases: [],
      configurationStatus: 'unconfigured' as const,
    },
  ];

  it('rows 驱动：custom 进列；空数组/省略 → 编译期三 builtin（chips 永不变空）', () => {
    expect(listSubjectChoices(rows).map((c) => c.id)).toEqual(['yuwen', 'subj_chem1', 'yingyu']);
    const compiled = listSubjectChoices([]).map((c) => c.id);
    expect(compiled).toEqual(['yuwen', 'math', 'physics']);
    expect(listSubjectChoices()).toEqual(listSubjectChoices([]));
  });

  it('subjectDisplayName：rows 优先（custom 只有行认识）、alias 归一后查行、miss 回编译期再回原串', () => {
    expect(subjectDisplayName('subj_chem1', rows)).toBe('化学 · 通用模式');
    expect(subjectDisplayName('wenyan', rows)).toBe('语文'); // alias → canonical 后行命中
    expect(subjectDisplayName('huaxue', rows)).toBe('化学 · 通用模式'); // runtime custom alias → 行命中
    expect(subjectDisplayName('yingyu', rows)).toBe('未配置学科 · yingyu');
    expect(subjectDisplayName('math', rows)).toBe('数学'); // 行 miss → 编译期 builtin
    expect(subjectDisplayName('subj_ghost', rows)).toBe('subj_ghost'); // 全 miss → 原串
  });

  it('subjectIdentityKey：builtin / runtime alias / raw unknown 各自保留身份', () => {
    expect(subjectIdentityKey('wenyan', rows)).toBe('yuwen');
    expect(subjectIdentityKey('huaxue', rows)).toBe('subj_chem1');
    expect(subjectIdentityKey(' YINGYU ', rows)).toBe('yingyu');
    expect(subjectIdentityKey(null, rows)).toBeNull();
  });
});
