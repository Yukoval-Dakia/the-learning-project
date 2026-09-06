import { describe, expect, it, vi } from 'vitest';
import { extractPrimaryView } from './reply-finalization';

// Legacy marker parsing remains for safe cleanup, never presentation authorization.
describe('legacy primary-view marker cleanup', () => {
  it('T3: lenient validation — bad source / ref shape / over-cap ephemeral_html → absent + stripped', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const badMarkers = [
      '<!--primary_view:{"source":"bogus","ref":{"kind":"a","id":"b"}}-->',
      '<!--primary_view:{"source":"artifact","ref":"not-an-object"}-->',
      '<!--primary_view:{"source":"tool_result","ref":{"kind":"","id":"x"}}-->',
      `<!--primary_view:{"source":"ephemeral_html","ref":"${'x'.repeat(32_001)}"}-->`,
    ];
    for (const marker of badMarkers) {
      const out = extractPrimaryView(`body\n${marker}`, { taskRunId: 't' });
      expect(out.primaryView).toBeUndefined();
      expect(out.text).toBe('body');
    }
    expect(warnSpy).toHaveBeenCalledTimes(badMarkers.length);
    warnSpy.mockRestore();
  });

  it('parses the tool_result + ephemeral_html sources too (all three ruled variants)', () => {
    const tr = extractPrimaryView(
      'x\n<!--primary_view:{"source":"tool_result","ref":{"kind":"tool_call","id":"tc_1"}}-->',
      { taskRunId: 't' },
    );
    expect(tr.primaryView).toEqual({
      source: 'tool_result',
      ref: { kind: 'tool_call', id: 'tc_1' },
    });
    const eh = extractPrimaryView(
      'x\n<!--primary_view:{"source":"ephemeral_html","ref":"<div>hi</div>"}-->',
      { taskRunId: 't' },
    );
    expect(eh.primaryView).toEqual({ source: 'ephemeral_html', ref: '<div>hi</div>' });
  });
  it('T5: multiple markers → the LAST valid one wins; ALL occurrences stripped', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first =
      '<!--primary_view:{"source":"artifact","ref":{"kind":"question","id":"q_first"}}-->';
    const bad = '<!--primary_view:{nope}-->';
    const last = '<!--primary_view:{"source":"artifact","ref":{"kind":"quiz","id":"qz_last"}}-->';
    const out = extractPrimaryView(`a ${first} b ${bad} c\n${last}`, { taskRunId: 't' });
    expect(out.primaryView).toEqual({ source: 'artifact', ref: { kind: 'quiz', id: 'qz_last' } });
    expect(out.text).toBe('a  b  c');
    expect(out.text).not.toContain('primary_view');
    warnSpy.mockRestore();
  });

  it('T5b: ephemeral_html payload containing `-->` parses via the greedy tail pass; zero residue (PR #375 MEDIUM-1)', () => {
    const html = '<div><!-- inner comment --><b>周期表</b></div>';
    // JSON.stringify builds the payload — correct escaping by construction
    // (a hand-rolled quote-replace trips CodeQL js/incomplete-sanitization).
    const payload = JSON.stringify({ source: 'ephemeral_html', ref: html });
    const out = extractPrimaryView(`正文。\n<!--primary_view:${payload}-->`, { taskRunId: 't' });
    // The greedy tail match swallows the inner `-->` — nomination SUCCEEDS
    // (was: lenient-absent under the lazy-only parser)…
    expect(out.primaryView).toEqual({ source: 'ephemeral_html', ref: html });
    // …and the whole marker region is removed: no payload residue in reply_md.
    expect(out.text).toBe('正文。');
    expect(out.text).not.toContain('primary_view');
    expect(out.text).not.toContain('ephemeral_html');
  });

  it('T5c: unterminated marker (stream aborted mid-marker) → truncated + warn, nothing leaks (PR #375 MEDIUM-2)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = extractPrimaryView('正文先到。\n<!--primary_view:{"source":"artifa', {
      taskRunId: 't',
    });
    expect(out.primaryView).toBeUndefined();
    expect(out.text).toBe('正文先到。');
    expect(out.text).not.toContain('<!--');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});
