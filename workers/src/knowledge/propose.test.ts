import { describe, expect, it } from 'vitest';
import { parseProposeOutput } from './propose';

describe('parseProposeOutput', () => {
  it('parses well-formed JSON with proposals array', () => {
    const text = '{"proposals":[{"name":"之-主谓间用法","parent_id":"k_xuci","reasoning":"该错题表明..."}]}';
    const out = parseProposeOutput(text);
    expect(out.proposals).toHaveLength(1);
    expect(out.proposals[0].name).toBe('之-主谓间用法');
    expect(out.proposals[0].parent_id).toBe('k_xuci');
  });

  it('extracts JSON from text with surrounding prose', () => {
    const text = '好的，我建议如下：\n\n{"proposals":[{"name":"X","parent_id":"k1","reasoning":"r"}]}\n\n以上。';
    const out = parseProposeOutput(text);
    expect(out.proposals).toHaveLength(1);
  });

  it('returns empty proposals when LLM returns 0 entries', () => {
    const text = '{"proposals":[]}';
    const out = parseProposeOutput(text);
    expect(out.proposals).toHaveLength(0);
  });

  it('throws on non-JSON garbage', () => {
    expect(() => parseProposeOutput('完全不是 JSON')).toThrow();
  });

  it('throws on JSON missing proposals array', () => {
    expect(() => parseProposeOutput('{"foo":"bar"}')).toThrow();
  });

  it('throws when proposals exceeds 3 entries', () => {
    const items = Array.from({ length: 4 }, (_, i) => ({
      name: `n${i}`,
      parent_id: 'p',
      reasoning: 'r',
    }));
    const text = JSON.stringify({ proposals: items });
    expect(() => parseProposeOutput(text)).toThrow();
  });

  it('throws when an entry has empty name or reasoning', () => {
    const text = '{"proposals":[{"name":"","parent_id":"p","reasoning":"r"}]}';
    expect(() => parseProposeOutput(text)).toThrow();
  });
});
