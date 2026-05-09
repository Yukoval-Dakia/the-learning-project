import { describe, expect, it } from 'vitest';
import { parseAttributionOutput } from './attribute';

describe('parseAttributionOutput', () => {
  it('parses well-formed JSON with all fields', () => {
    const text = '{"primary_category":"concept","secondary_categories":["memory"],"ai_analysis_md":"用户混淆了「之」的助词和动词用法","confidence":0.85}';
    const out = parseAttributionOutput(text);
    expect(out.primary_category).toBe('concept');
    expect(out.secondary_categories).toEqual(['memory']);
    expect(out.confidence).toBe(0.85);
  });

  it('extracts JSON from text with surrounding prose', () => {
    const text = '分析如下：\n\n{"primary_category":"reading","secondary_categories":[],"ai_analysis_md":"未注意「之」位置","confidence":0.6}\n\n以上。';
    const out = parseAttributionOutput(text);
    expect(out.primary_category).toBe('reading');
  });

  it('defaults secondary_categories to []', () => {
    const text = '{"primary_category":"other","ai_analysis_md":"无法判断","confidence":0.2}';
    const out = parseAttributionOutput(text);
    expect(out.secondary_categories).toEqual([]);
  });

  it('throws on non-JSON garbage', () => {
    expect(() => parseAttributionOutput('完全不是 JSON')).toThrow();
  });

  it('throws on invalid primary_category', () => {
    const text = '{"primary_category":"bogus","ai_analysis_md":"r","confidence":0.5}';
    expect(() => parseAttributionOutput(text)).toThrow();
  });

  it('throws when confidence out of range', () => {
    const text = '{"primary_category":"concept","ai_analysis_md":"r","confidence":1.5}';
    expect(() => parseAttributionOutput(text)).toThrow();
  });

  it('throws when ai_analysis_md missing', () => {
    const text = '{"primary_category":"concept","confidence":0.5}';
    expect(() => parseAttributionOutput(text)).toThrow();
  });
});
