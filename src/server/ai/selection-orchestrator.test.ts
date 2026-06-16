// YUK-361 Phase 3 Step B — SelectionOrchestratorTask parse barrier + 分桶格式化器
// 单测（no DB, no live LLM — feeds raw text / plain signal objects directly）。
//
// NOTE: this is a UNIT test. selection-orchestrator.ts imports only the Zod schema
// + `import type { CollectedSignal }` (type-only, erased at compile time), so no DB
// dependency is pulled in at runtime — safe for the unit partition.

import type { CollectedSignal } from '@/capabilities/practice/server/candidate-signals';
import { describe, expect, it } from 'vitest';
import {
  bucketMfi,
  bucketUnit,
  buildSelectionOrchestratorInput,
  parseSelectionOrchestratorOutput,
} from './selection-orchestrator';

// ───────────────────────────────────────────────────────────────────────────
// parse barrier
// ───────────────────────────────────────────────────────────────────────────

const INPUT_REF_IDS = ['q-1', 'q-2', 'q-3'];

function validJson(): string {
  return JSON.stringify({
    candidates: [
      { refId: 'q-1', weight: 2, role: 'diagnostic', arrangement: 1, reason: 'a' },
      { refId: 'q-2', weight: 0.5, role: 'frontier', reason: 'b' },
    ],
  });
}

describe('parseSelectionOrchestratorOutput', () => {
  it('parses valid JSON → typed candidates', () => {
    const out = parseSelectionOrchestratorOutput(validJson(), INPUT_REF_IDS);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ refId: 'q-1', weight: 2, role: 'diagnostic', arrangement: 1 });
    expect(out[1]).toMatchObject({ refId: 'q-2', weight: 0.5, role: 'frontier' });
    expect(out[1].arrangement).toBeUndefined();
  });

  it('brace-slices JSON out of noisy text (markdown fence + prose)', () => {
    const noisy = `好的，这是我的编排：\n\`\`\`json\n${validJson()}\n\`\`\`\n以上。`;
    const out = parseSelectionOrchestratorOutput(noisy, INPUT_REF_IDS);
    expect(out.map((c) => c.refId)).toEqual(['q-1', 'q-2']);
  });

  it('drops unknown / hallucinated refIds (does not throw)', () => {
    const text = JSON.stringify({
      candidates: [
        { refId: 'q-1', weight: 1, role: 'diagnostic', reason: 'a' },
        { refId: 'q-HALLUCINATED', weight: 5, role: 'frontier', reason: 'made up' },
        { refId: 'q-2', weight: 1, role: 'frontier', reason: 'b' },
      ],
    });
    const out = parseSelectionOrchestratorOutput(text, INPUT_REF_IDS);
    expect(out.map((c) => c.refId)).toEqual(['q-1', 'q-2']);
  });

  it('dedups repeated refIds (keeps the FIRST occurrence)', () => {
    const text = JSON.stringify({
      candidates: [
        { refId: 'q-1', weight: 1, role: 'diagnostic', reason: 'first' },
        { refId: 'q-1', weight: 9, role: 'frontier', reason: 'dup' },
        { refId: 'q-2', weight: 2, role: 'frontier', reason: 'b' },
      ],
    });
    const out = parseSelectionOrchestratorOutput(text, INPUT_REF_IDS);
    expect(out).toHaveLength(2);
    const q1 = out.find((c) => c.refId === 'q-1');
    expect(q1).toMatchObject({ weight: 1, reason: 'first' });
  });

  it('rejects a negative weight (Zod min(0) barrier → throw)', () => {
    const text = JSON.stringify({
      candidates: [{ refId: 'q-1', weight: -1, role: 'diagnostic', reason: 'bad' }],
    });
    expect(() => parseSelectionOrchestratorOutput(text, INPUT_REF_IDS)).toThrow(/schema invalid/);
  });

  it('rejects a non-finite weight (FINDING 3: 1e309 → Infinity → .finite() barrier → throw)', () => {
    // Raw text with a literal 1e309 (NOT JSON.stringify'd — Infinity isn't valid JSON
    // but `1e309` is a valid JSON number token that JSON.parse maps to Infinity).
    const text = '{"candidates":[{"refId":"q-1","weight":1e309,"role":"diagnostic","reason":"x"}]}';
    expect(() => parseSelectionOrchestratorOutput(text, INPUT_REF_IDS)).toThrow(/schema invalid/);
  });

  it('throws when no JSON object is present', () => {
    expect(() => parseSelectionOrchestratorOutput('抱歉我无法完成', INPUT_REF_IDS)).toThrow(
      /no JSON object found/,
    );
  });

  it('throws on malformed JSON (braces present but unparseable body)', () => {
    // Has both '{' and '}' (so brace-slice produces a slice), but the body is not
    // valid JSON (unquoted keys / trailing comma) → JSON.parse failure path.
    expect(() =>
      parseSelectionOrchestratorOutput('noise {candidates: [refId: q-1,]} tail', INPUT_REF_IDS),
    ).toThrow(/JSON\.parse failed/);
  });

  it('throws when ALL candidates are filtered out (no valid candidates left)', () => {
    const text = JSON.stringify({
      candidates: [{ refId: 'q-UNKNOWN', weight: 1, role: 'diagnostic', reason: 'x' }],
    });
    expect(() => parseSelectionOrchestratorOutput(text, INPUT_REF_IDS)).toThrow(
      /no valid candidates/,
    );
  });

  it('throws on an empty candidates array (schema min(1))', () => {
    const text = JSON.stringify({ candidates: [] });
    expect(() => parseSelectionOrchestratorOutput(text, INPUT_REF_IDS)).toThrow(/schema invalid/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// bucketing formatter
// ───────────────────────────────────────────────────────────────────────────

describe('bucketMfi', () => {
  it('produces stable bands at fixed [0, 0.25] boundaries', () => {
    expect(bucketMfi(undefined)).toBe('n/a');
    expect(bucketMfi(0)).toBe('low');
    expect(bucketMfi(0.05)).toBe('low'); // < 0.25/3 ≈ 0.083
    expect(bucketMfi(0.1)).toBe('mid'); // between 0.083 and 0.167
    expect(bucketMfi(0.25)).toBe('high'); // ≥ 2·0.25/3 ≈ 0.167
    expect(bucketMfi(0.2)).toBe('high');
  });

  it('is stable: same input → same band regardless of context', () => {
    expect(bucketMfi(0.2)).toBe(bucketMfi(0.2));
  });
});

describe('bucketUnit', () => {
  it('bands a 0-1 signal at thirds; undefined → n/a', () => {
    expect(bucketUnit(undefined)).toBe('n/a');
    expect(bucketUnit(0)).toBe('low');
    expect(bucketUnit(0.5)).toBe('mid');
    expect(bucketUnit(0.9)).toBe('high');
    expect(bucketUnit(2 / 3)).toBe('high');
    expect(bucketUnit(1 / 3)).toBe('mid');
  });
});

describe('buildSelectionOrchestratorInput', () => {
  function questionSignal(over: Partial<CollectedSignal>): CollectedSignal {
    return {
      refKind: 'question',
      refId: 'q-1',
      role: 'diagnostic',
      bSource: 'item_calibration',
      ...over,
    } as CollectedSignal;
  }

  it('projects a calibrated diagnostic candidate with bucketed (not raw) signals', () => {
    const line = buildSelectionOrchestratorInput([
      questionSignal({ refId: 'q-1', mfiScore: 0.24, diagnosticScore: 0.05 }),
    ]);
    expect(line).toContain('refId=q-1');
    expect(line).toContain('role=diagnostic');
    expect(line).toContain('mfi=high'); // 0.24 → high
    expect(line).toContain('diagnostic=low'); // 0.05 → low
    expect(line).toContain('difficulty_anchor=calibrated');
    // No raw floats leak into the prompt.
    expect(line).not.toContain('0.24');
    expect(line).not.toContain('0.05');
  });

  it('labels a rough_estimate (difficulty_proxy) anchor', () => {
    const line = buildSelectionOrchestratorInput([
      questionSignal({ bSource: 'difficulty_proxy', mfiScore: 0.1 }),
    ]);
    expect(line).toContain('difficulty_anchor=rough_estimate');
  });

  it('marks recall-locked candidates and omits mfi bands for them', () => {
    const line = buildSelectionOrchestratorInput([
      questionSignal({ refId: 'q-r', recallLocked: true }),
    ]);
    expect(line).toContain('recall_locked=true');
    expect(line).not.toContain('mfi=');
    expect(line).not.toContain('diagnostic=');
  });

  it('renders §9.2 signals as n/a when undefined (Step A leaves them undefined)', () => {
    const line = buildSelectionOrchestratorInput([questionSignal({ mfiScore: 0.1 })]);
    expect(line).toContain('exam_relevance=n/a');
    expect(line).toContain('misconception_recurrence=n/a');
    expect(line).toContain('transfer_gap=n/a');
  });

  it('projects a paper candidate (role=paper, no mfi)', () => {
    const line = buildSelectionOrchestratorInput([
      { refKind: 'paper', refId: 'p-1', role: 'paper', bSource: 'none' } as CollectedSignal,
    ]);
    expect(line).toContain('refKind=paper');
    expect(line).toContain('role=paper');
    expect(line).toContain('difficulty_anchor=unknown');
  });

  it('renders one line per candidate (newline-joined)', () => {
    const block = buildSelectionOrchestratorInput([
      questionSignal({ refId: 'q-1', mfiScore: 0.1 }),
      questionSignal({ refId: 'q-2', mfiScore: 0.2 }),
    ]);
    expect(block.split('\n')).toHaveLength(2);
  });

  it('returns an empty string for no candidates', () => {
    expect(buildSelectionOrchestratorInput([])).toBe('');
  });
});
