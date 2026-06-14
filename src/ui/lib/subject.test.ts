import { describe, expect, it } from 'vitest';
import { type SlimSubjectProfile, resolveSubjectRenderModel, subjectContentProps } from './subject';

const baseProfile: SlimSubjectProfile = {
  id: 'wenyan',
  displayName: '文言文',
  renderConfig: {
    font_family: 'serif-cjk',
    notation: null,
    code_highlight: null,
  },
};

describe('resolveSubjectRenderModel', () => {
  it('maps serif-cjk content to the wenyan font token', () => {
    const model = resolveSubjectRenderModel(baseProfile);

    expect(model.id).toBe('wenyan');
    expect(model.displayName).toBe('文言文');
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
