import {
  CauseCategoryDeclaration,
  RenderConfig,
  SchedulingHints,
} from '@/core/schema/profile-decl';
import { describe, expect, it } from 'vitest';

describe('CauseCategoryDeclaration', () => {
  it('accepts valid cause with label only', () => {
    const result = CauseCategoryDeclaration.safeParse({
      id: 'unit_error',
      label: '单位错误',
    });
    expect(result.success).toBe(true);
  });

  it('accepts cause with description and source_pack', () => {
    const result = CauseCategoryDeclaration.safeParse({
      id: 'model_selection',
      label: '模型选择错误',
      description: '选错了物理模型或公式',
      source_pack: { id: 'science_common', version: '1.0.0' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty id', () => {
    expect(CauseCategoryDeclaration.safeParse({ id: '', label: 'x' }).success).toBe(false);
  });

  it('rejects id with spaces', () => {
    expect(CauseCategoryDeclaration.safeParse({ id: 'has space', label: 'x' }).success).toBe(false);
  });
});

describe('RenderConfig', () => {
  it('accepts wenyan-style config', () => {
    const result = RenderConfig.safeParse({
      font_family: 'serif-cjk',
      notation: null,
      code_highlight: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts math-style config with katex', () => {
    const result = RenderConfig.safeParse({
      font_family: 'system',
      notation: 'katex',
      code_highlight: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts programming config with code highlight', () => {
    const result = RenderConfig.safeParse({
      font_family: 'monospace',
      notation: null,
      code_highlight: 'typescript',
    });
    expect(result.success).toBe(true);
  });
});

describe('SchedulingHints', () => {
  it('accepts fsrs default', () => {
    const result = SchedulingHints.safeParse({ default_policy: 'fsrs' });
    expect(result.success).toBe(true);
  });

  it('accepts none_evidence_only for records', () => {
    const result = SchedulingHints.safeParse({
      default_policy: 'none_evidence_only',
    });
    expect(result.success).toBe(true);
  });
});
