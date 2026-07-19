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

function render(data: unknown): string {
  const qc = new QueryClient();
  qc.setQueryData(['admin-conjecture-scores'], data);
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
});
