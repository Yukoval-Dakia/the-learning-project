// Station 2A (YUK-185, T-37) — runBriefWriter unit tests (NO live LLM).
//
// The runTaskFn seam is stubbed: the real runTask is never imported, no
// ANTHROPIC_API_KEY / XIAOMI_API_KEY needed. Covers: brace-slice parse (incl a
// fenced blob), the D3 id-subset filter (invented ids dropped), facts never
// leaking into evidence arrays, the 4A cold-scope short-circuit (stub never
// called), and the 3A `now`/projection input the writer hands the model.

import { describe, expect, it, vi } from 'vitest';

import type { TaskTextRunFn } from '@/server/ai/provenance';
import type { BriefEvent, BriefFact } from './brief';
import { BriefDraftOutputSchema, parseBriefDraftOutput, runBriefWriter } from './brief-writer';

const NOW = new Date('2026-06-01T00:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

function evt(
  id: string,
  createdAt: Date,
  payload: unknown = {},
  outcome: string | null = null,
): BriefEvent {
  return {
    id,
    action: 'attempt',
    subject_kind: 'question',
    subject_id: `q-${id}`,
    outcome,
    payload,
    created_at: createdAt,
  };
}

function draftBlob(over: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    recent_week_md: '## week',
    recent_months_md: '## months',
    long_term_md: '## long',
    recent_week_evidence_ids: [],
    recent_months_evidence_ids: [],
    long_term_evidence_ids: [],
    ...over,
  });
}

describe('parseBriefDraftOutput', () => {
  it('parses a valid blob into the 6 BriefDraft fields', () => {
    const parsed = parseBriefDraftOutput(draftBlob({ recent_week_evidence_ids: ['a'] }));
    expect(parsed.recent_week_md).toBe('## week');
    expect(parsed.recent_week_evidence_ids).toEqual(['a']);
    expect(parsed.long_term_evidence_ids).toEqual([]);
  });

  it('brace-slice tolerates a ```json fenced blob', () => {
    const fenced = `Here you go:\n\`\`\`json\n${draftBlob({ long_term_md: '## fenced' })}\n\`\`\``;
    const parsed = parseBriefDraftOutput(fenced);
    expect(parsed.long_term_md).toBe('## fenced');
  });

  it('throws when no JSON object is present', () => {
    expect(() => parseBriefDraftOutput('no braces here')).toThrow(/no JSON object/);
  });

  // PR #232 review (FIX #3) — all 6 keys are now REQUIRED. A response that DROPS
  // a section must FAIL parse (so the F-1 per-scope catch in triggers.ts leaves
  // the prior brief intact) rather than silently parse into an all-empty draft
  // and let regenerateMemoryBrief upsert ''/[] over a good prior brief.
  it('throws when the response is missing a key (no silent default-to-empty)', () => {
    expect(() => BriefDraftOutputSchema.parse({ recent_week_md: 'x' })).toThrow();
    // A complete-but-empty response is still legitimate (empty windows allowed).
    const full = BriefDraftOutputSchema.parse(JSON.parse(draftBlob()));
    expect(full.recent_months_md).toBe('## months');
    expect(full.long_term_evidence_ids).toEqual([]);
  });

  it('allows empty-string md VALUES but not a missing md KEY', () => {
    const emptyMd = BriefDraftOutputSchema.parse(
      JSON.parse(draftBlob({ recent_week_md: '', recent_months_md: '', long_term_md: '' })),
    );
    expect(emptyMd.recent_week_md).toBe('');
    // Drop a single key (long_term_evidence_ids) → throws.
    const partial = JSON.parse(draftBlob());
    // biome-ignore lint/performance/noDelete: test fixture — assert a dropped key fails parse.
    delete partial.long_term_evidence_ids;
    expect(() => BriefDraftOutputSchema.parse(partial)).toThrow();
  });
});

describe('runBriefWriter', () => {
  const baseEvents = [evt('e1', daysAgo(1)), evt('e2', daysAgo(40)), evt('e3', daysAgo(200))];
  const facts: BriefFact[] = [{ id: 'fact-1', memory: 'prefers contrastive examples' }];

  it('keeps only ids that exist in the input events (D3 filter drops invented ids)', async () => {
    const stub: TaskTextRunFn = vi.fn(async () => ({
      text: draftBlob({
        recent_week_evidence_ids: ['e1', 'invented-x'],
        recent_months_evidence_ids: ['e2'],
        long_term_evidence_ids: ['e3', 'fact-1', 'ghost'],
      }),
    }));

    const draft = await runBriefWriter({
      runTaskFn: stub,
      scopeKey: 'global',
      template: 'summarize globally',
      events: baseEvents,
      facts,
      now: NOW.toISOString(),
    });

    expect(draft.recent_week_evidence_ids).toEqual(['e1']); // invented-x dropped
    expect(draft.recent_months_evidence_ids).toEqual(['e2']);
    // fact-1 (a fact id) + ghost (invented) both dropped — only the real event id remains.
    expect(draft.long_term_evidence_ids).toEqual(['e3']);
  });

  it('hands the model an input carrying the ISO `now` (3A) and projected payloads (I-3)', async () => {
    const captured: { kind?: string; input?: unknown } = {};
    const stub: TaskTextRunFn = vi.fn(async (kind, input) => {
      captured.kind = kind;
      captured.input = input;
      return { text: draftBlob() };
    });

    const longText = 'x'.repeat(500);
    await runBriefWriter({
      runTaskFn: stub,
      scopeKey: 'subject:s1',
      template: 'summarize subject',
      // FIX #1 — `outcome` is the 4th arg (the event COLUMN), no longer read from
      // the payload. `payload.outcome` here is junk and must NOT be projected.
      events: [
        evt(
          'e1',
          daysAgo(2),
          { outcome: 'ignored-in-payload', answer_md: longText, junk: 'drop me' },
          'failure',
        ),
      ],
      facts,
      now: NOW.toISOString(),
    });

    expect(captured.kind).toBe('MemoryBriefTask');
    const input = captured.input as {
      now: string;
      scope_key: string;
      events: { id: string; outcome?: string; payload: { excerpt?: string } }[];
      facts: { id: string; memory: string }[];
    };
    expect(input.now).toBe(NOW.toISOString()); // 3A — real-clock anchor threaded
    expect(input.scope_key).toBe('subject:s1');
    // FIX #1 — `outcome` comes from the top-level event field, NOT the payload.
    expect(input.events[0].outcome).toBe('failure');
    // I-3 — payload projected to { excerpt? }, excerpt hard-truncated to 180; the
    // payload no longer carries `outcome`.
    expect((input.events[0].payload as Record<string, unknown>).outcome).toBeUndefined();
    expect(input.events[0].payload.excerpt).toHaveLength(180);
    expect((input.events[0].payload as Record<string, unknown>).junk).toBeUndefined();
    // facts are passed but as { id, memory } — not as evidence.
    expect(input.facts[0]).toEqual({ id: 'fact-1', memory: 'prefers contrastive examples' });
  });

  it('projects review / record / note text fields into the excerpt (FIX #2)', async () => {
    const captured: { input?: unknown } = {};
    const stub: TaskTextRunFn = vi.fn(async (_kind, input) => {
      captured.input = input;
      return { text: draftBlob() };
    });

    await runBriefWriter({
      runTaskFn: stub,
      scopeKey: 'global',
      template: 'summarize globally',
      events: [
        // review reply text lives in payload.user_response_md
        evt('rev', daysAgo(1), { user_response_md: 'my review answer' }),
        // record capture text lives in payload.summary_md
        evt('rec', daysAgo(2), { summary_md: 'captured summary' }),
        // note text lives in payload.content_md
        evt('note', daysAgo(3), { content_md: 'note body' }),
      ],
      facts,
      now: NOW.toISOString(),
    });

    const input = captured.input as {
      events: { id: string; payload: { excerpt?: string } }[];
    };
    expect(input.events.find((e) => e.id === 'rev')?.payload.excerpt).toBe('my review answer');
    expect(input.events.find((e) => e.id === 'rec')?.payload.excerpt).toBe('captured summary');
    expect(input.events.find((e) => e.id === 'note')?.payload.excerpt).toBe('note body');
  });

  it('cold-scope (events: []) returns an all-empty draft WITHOUT calling the stub (4A)', async () => {
    const stub: TaskTextRunFn = vi.fn(async () => ({ text: draftBlob() }));

    const draft = await runBriefWriter({
      runTaskFn: stub,
      scopeKey: 'global',
      template: 'summarize globally',
      events: [],
      facts,
      now: NOW.toISOString(),
    });

    expect(stub).not.toHaveBeenCalled(); // no paid LLM round-trip on a cold scope
    expect(draft).toEqual({
      recent_week_md: '',
      recent_months_md: '',
      long_term_md: '',
      recent_week_evidence_ids: [],
      recent_months_evidence_ids: [],
      long_term_evidence_ids: [],
    });
  });

  it('never emits a fact id into any evidence array even when the model cites it', async () => {
    const stub: TaskTextRunFn = vi.fn(async () => ({
      text: draftBlob({ long_term_evidence_ids: ['fact-1', 'fact-1'] }),
    }));

    const draft = await runBriefWriter({
      runTaskFn: stub,
      scopeKey: 'global',
      template: 'summarize globally',
      events: baseEvents,
      facts,
      now: NOW.toISOString(),
    });

    expect(draft.long_term_evidence_ids).toEqual([]);
  });
});
