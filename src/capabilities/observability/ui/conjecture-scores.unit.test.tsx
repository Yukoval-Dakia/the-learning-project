// YUK-617 mode-1 — AdminConjectureScoresSurface render 覆盖（SSR renderToString + 喂缓存，无 jsdom）。
// 锁：诚实栏（single-point，非 accuracy/窗口均值）恒出、两表渲染、空态、KPI 聚合。

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AdminConjectureScoresSurface } from './conjecture-scores';

function score(overrides: Record<string, unknown> = {}) {
  return {
    event_id: 'ev_s1',
    conjecture_event_id: 'ev_c1',
    probe_result_event_id: 'ev_p1',
    knowledge_id: 'k_xuci',
    predicted_p: 0.72,
    baseline_p: 0.5,
    outcome: 1,
    resolution: 'confirmed',
    brier_model: 0.08,
    brier_baseline: 0.25,
    log_loss_model: 0.33,
    skill_score_point: 0.68,
    retrievability_at_judge: 0.9,
    created_at: '2026-07-11T00:00:00.000Z',
    ...overrides,
  };
}
function typedState(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ts1',
    knowledge_id: 'k_xuci',
    typed_state: 'confused-with-X',
    confused_with_kc_id: 'k_shici',
    lifecycle: 'open',
    evidence_event_ids: ['e1', 'e2'],
    last_evidence_at: '2026-07-11T00:00:00.000Z',
    updated_at: '2026-07-11T00:00:00.000Z',
    ...overrides,
  };
}

function cleanDiagnostics() {
  return {
    prediction_scores: { scanned_count: 0, dropped_count: 0, scan_truncated: false },
    typed_states: { scanned_count: 0, dropped_count: 0, scan_truncated: false },
  };
}

function render(data: unknown): string {
  const qc = new QueryClient();
  const hydrated =
    data && typeof data === 'object' && !Array.isArray(data)
      ? { diagnostics: cleanDiagnostics(), ...data }
      : data;
  qc.setQueryData(['admin-conjecture-scores'], hydrated);
  return renderToString(
    <QueryClientProvider client={qc}>
      <AdminConjectureScoresSurface navigate={() => {}} />
    </QueryClientProvider>,
  );
}

describe('AdminConjectureScoresSurface', () => {
  it('always renders the single-point honesty rail (not accuracy / not window mean)', () => {
    const html = render({ score_basis: 'single_point', prediction_scores: [], typed_states: [] });
    expect(html).toContain('single-point proper score');
    expect(html).toContain('NOT');
    expect(html).toContain('accuracy');
  });

  it('renders both tables with rows when data present', () => {
    const html = render({
      score_basis: 'single_point',
      prediction_scores: [score()],
      typed_states: [typedState()],
    });
    expect(html).toContain('prediction scores');
    expect(html).toContain('typed states');
    expect(html).toContain('k_xuci'); // KC id
    expect(html).toContain('k_shici'); // confused-with
    expect(html).toContain('答对'); // outcome=1
  });

  it('shows empty-state prose for each section when no rows', () => {
    const html = render({ score_basis: 'single_point', prediction_scores: [], typed_states: [] });
    expect(html).toContain('尚未产出 prediction_score');
    expect(html).toContain('尚未铸出');
  });

  it('surfaces the KPI aggregates (prediction count + open typed-state count)', () => {
    const html = render({
      score_basis: 'single_point',
      prediction_scores: [score(), score({ event_id: 'ev_s2' })],
      typed_states: [typedState(), typedState({ id: 'ts2', lifecycle: 'resolved' })],
    });
    expect(html).toContain('predictions');
    expect(html).toContain('1 open'); // one open of two typed states
  });

  it('never fabricates a window-level baseline verdict from point skill scores (honesty)', () => {
    // Even with data, the "beats/below baseline" window claim must NOT be derived from
    // averaging degenerate single-point skill_score_point — window BSS is DEFERRED (ADR-0046).
    const html = render({
      score_basis: 'single_point',
      prediction_scores: [score(), score({ event_id: 'ev_s2', skill_score_point: 0.9 })],
      typed_states: [],
    });
    expect(html).not.toContain('beats baseline');
    expect(html).not.toContain('below baseline');
    expect(html).toContain('deferred'); // window skill honestly marked deferred
  });

  it('renders absent score metrics as dashes without counting them as zero in the mean', () => {
    const html = render({
      score_basis: 'single_point',
      prediction_scores: [
        score({ brier_model: null, brier_baseline: null, skill_score_point: null }),
      ],
      typed_states: [],
    });
    expect(html).toContain('mean Brier');
    expect(html).toContain('—');
    expect(html).not.toContain('0.000');
  });

  it('compares mean Brier on paired complete-case rows only', () => {
    const html = render({
      score_basis: 'single_point',
      prediction_scores: [
        score({ brier_model: 0.4, brier_baseline: 0.3 }),
        score({ event_id: 'ev_s2', brier_model: null, brier_baseline: 1 }),
      ],
      typed_states: [],
    });
    expect(html).toContain('0.400');
    expect(html).toContain('baseline 0.300 · paired n=1');
    expect(html).not.toContain('baseline 0.650');
  });

  it('keeps the normal path quiet when no rows were dropped or truncated', () => {
    const html = render({ score_basis: 'single_point', prediction_scores: [], typed_states: [] });
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-atomic="true"');
    expect(html).not.toContain('部分诊断行未展示');
    expect(html).not.toContain('data quality');
  });

  it('surfaces dropped rows and bounded-window truncation without hiding valid results', () => {
    const html = render({
      score_basis: 'single_point',
      prediction_scores: [score()],
      typed_states: [],
      diagnostics: {
        prediction_scores: { scanned_count: 400, dropped_count: 201, scan_truncated: true },
        typed_states: { scanned_count: 3, dropped_count: 1, scan_truncated: false },
      },
    });
    const text = html.replaceAll('<!-- -->', '');
    expect(text).toContain('部分诊断行未展示');
    expect(text).toContain('prediction scores：扫描 400 行，丢弃 201 行');
    expect(text).toContain('已触及有界窗口，结果可能不完整');
    expect(text).toContain('typed states：扫描 3 行，丢弃 1 行');
    expect(text).toContain('k_xuci');
  });
});
