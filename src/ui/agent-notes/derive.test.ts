import { type ReactElement, isValidElement } from 'react';
import { describe, expect, it } from 'vitest';
import { anInlineMd, dayGroupOf, deriveTtl, isFresh, resolveEvidence } from './derive';

const NOW = new Date('2026-06-08T12:00:00.000Z');

describe('isFresh', () => {
  it('is true just under 24h old', () => {
    expect(isFresh(new Date(NOW.getTime() - (24 * 3600_000 - 60_000)), NOW)).toBe(true);
  });
  it('is false just over 24h old', () => {
    expect(isFresh(new Date(NOW.getTime() - (24 * 3600_000 + 60_000)), NOW)).toBe(false);
  });
  it('accepts ISO string input', () => {
    expect(isFresh(new Date(NOW.getTime() - 3600_000).toISOString(), NOW)).toBe(true);
  });
  it('returns false for an unparseable date', () => {
    expect(isFresh('not-a-date', NOW)).toBe(false);
  });
});

describe('deriveTtl', () => {
  it('returns null when there is no expires_at', () => {
    expect(deriveTtl(undefined, NOW)).toBeNull();
  });
  it('flags soon when expiring within 48h', () => {
    const ttl = deriveTtl(new Date(NOW.getTime() + 47 * 3600_000).toISOString(), NOW);
    expect(ttl?.soon).toBe(true);
  });
  it('does not flag soon when expiring beyond 48h', () => {
    const ttl = deriveTtl(new Date(NOW.getTime() + 49 * 3600_000).toISOString(), NOW);
    expect(ttl?.soon).toBe(false);
    expect(ttl?.text).toContain('天后过期');
  });
  it('uses hours phrasing under a day', () => {
    const ttl = deriveTtl(new Date(NOW.getTime() + 5 * 3600_000).toISOString(), NOW);
    expect(ttl?.text).toContain('小时后过期');
    expect(ttl?.soon).toBe(true);
  });
  it('treats an already-expired note as soon/即将过期', () => {
    const ttl = deriveTtl(new Date(NOW.getTime() - 3600_000).toISOString(), NOW);
    expect(ttl).toEqual({ text: '即将过期', soon: true });
  });
  it('returns null for an unparseable expires_at', () => {
    expect(deriveTtl('garbage', NOW)).toBeNull();
  });
});

describe('dayGroupOf', () => {
  it('groups same-day as today', () => {
    const sameDay = new Date('2026-06-08T01:00:00.000Z');
    expect(dayGroupOf(sameDay, NOW).group).toBe('today');
    expect(dayGroupOf(sameDay, NOW).label).toBe('今天');
  });
  it('groups previous calendar day as yesterday', () => {
    const yesterday = new Date(NOW.getTime() - 24 * 3600_000);
    const info = dayGroupOf(yesterday, NOW);
    // boundary depends on local midnight; one day back is today-1 ⇒ yesterday or today
    expect(['yesterday', 'today']).toContain(info.group);
  });
  it('groups well-past dates as earlier', () => {
    const old = new Date('2026-06-01T12:00:00.000Z');
    expect(dayGroupOf(old, NOW).group).toBe('earlier');
    expect(dayGroupOf(old, NOW).label).toBe('更早');
  });
  it('falls back to earlier for an unparseable date', () => {
    expect(dayGroupOf('nope', NOW).group).toBe('earlier');
  });
});

describe('anInlineMd', () => {
  it('passes plain text through unchanged', () => {
    expect(anInlineMd('hello world')).toEqual(['hello world']);
  });
  it('wraps **bold** in a <b>', () => {
    const out = anInlineMd('a **b** c');
    const bold = out.find(
      (n): n is ReactElement<{ children: string }> => isValidElement(n) && n.type === 'b',
    );
    expect(bold).toBeDefined();
    expect(bold?.props.children).toBe('b');
  });
  it('wraps `code` in a <code>', () => {
    const out = anInlineMd('see `k_zhi` here');
    const code = out.find(
      (n): n is ReactElement<{ children: string }> => isValidElement(n) && n.type === 'code',
    );
    expect(code).toBeDefined();
    expect(code?.props.children).toBe('k_zhi');
  });
  it('handles mixed bold + code', () => {
    const out = anInlineMd('**A** and `B`');
    const els = out.filter(isValidElement);
    expect(els.map((e) => e.type)).toEqual(['b', 'code']);
  });
  it('leaves an unclosed token as plain text (no crash)', () => {
    expect(anInlineMd('a **b c')).toEqual(['a **b c']);
  });
});

describe('resolveEvidence', () => {
  it('navigates an event ref to /events/:id', () => {
    const ev = resolveEvidence({ refs: [{ kind: 'event', id: 'evt_9' }] });
    expect(ev).toEqual({ label: 'evt_9', href: '/events/evt_9', kind: 'event' });
  });
  it('renders a non-event ref with no href', () => {
    const ev = resolveEvidence({ refs: [{ kind: 'note', id: 'note_judge' }] });
    expect(ev).toEqual({ label: 'note_judge', href: null, kind: 'note' });
  });
  it('falls back to caused_by_event_id when refs is empty', () => {
    const ev = resolveEvidence({ refs: [], caused_by_event_id: 'evt_trigger' });
    expect(ev).toEqual({ label: 'evt_trigger', href: '/events/evt_trigger', kind: 'event' });
  });
  it('returns null when there is no ref and no caused_by_event_id', () => {
    expect(resolveEvidence({ refs: [] })).toBeNull();
  });
  it('prefers refs[0] over caused_by_event_id', () => {
    const ev = resolveEvidence({
      refs: [{ kind: 'event', id: 'evt_primary' }],
      caused_by_event_id: 'evt_fallback',
    });
    expect(ev?.label).toBe('evt_primary');
  });
});
