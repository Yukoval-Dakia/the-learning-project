// YUK-617 mode-1 — conjecture 预测评分只读观测面（admin 第六页）。
//
// 通电既有 GET /api/admin/conjecture-scores（conjecture-wire-spec §6 Q3 verdict-A 明确 specced
// 「admin observe 面 mirror observability four-page」为 S4 交付物——route + 读模型早已落，UI 半从没建，
// 消费路径一直是 curl+jq）。壳形态镜像 coverage-lattice（RootShell admin 页），非独立壳。
//
// 诚实栏（spec §6 S4）：prediction_scores 是 **single-point proper score**（brier/log_loss/skill_score_point
// 逐条判分，NOT accuracy / NOT window mean）——header 显式声明 score_basis，避免误读成准确率或窗口均值。
// typed_states 是 reconcile loop 自动铸的 confused-with-X 软轨结构态（provenance = evidence_event_ids）。

import { apiJson } from '@/ui/lib/api';
import { Badge } from '@/ui/primitives/Badge';
import { Card } from '@/ui/primitives/Card';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { Stateful } from '@/ui/primitives/Stateful';
import { useQuery } from '@tanstack/react-query';
import type { CSSProperties } from 'react';

// 字段对齐 server/conjecture-scores.ts 的 ConjectureScoresRead。
interface PredictionScoreRow {
  event_id: string;
  conjecture_event_id: string;
  probe_result_event_id: string;
  knowledge_id: string;
  predicted_p: number;
  baseline_p: number;
  outcome: 0 | 1;
  resolution: 'confirmed' | 'retired';
  brier_model: number | null;
  brier_baseline: number | null;
  log_loss_model: number | null;
  skill_score_point: number | null;
  retrievability_at_judge: number | null;
  created_at: string;
}
interface TypedStateRow {
  id: string;
  knowledge_id: string;
  typed_state: 'confused-with-X';
  confused_with_kc_id: string;
  lifecycle: 'open' | 'resolved';
  evidence_event_ids: string[];
  last_evidence_at: string | null;
  updated_at: string;
}
interface ConjectureScoresResponse {
  score_basis: 'single_point';
  prediction_scores: PredictionScoreRow[];
  typed_states: TypedStateRow[];
  diagnostics: {
    prediction_scores: ScanDiagnostics;
    typed_states: ScanDiagnostics;
  };
}
interface ScanDiagnostics {
  scanned_count: number;
  dropped_count: number;
  scan_truncated: boolean;
}

const NAV: Array<{ to: string; label: string }> = [
  { to: '/admin/runs', label: 'runs' },
  { to: '/admin/cost', label: 'cost' },
  { to: '/admin/failures', label: 'failures' },
  { to: '/admin/subjects', label: 'subjects' },
  { to: '/admin/coverage-lattice', label: 'coverage' },
  { to: '/admin/conjecture-scores', label: 'conjecture' },
];

function formatTime(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const fmt = (n: number | null) => (n === null ? '—' : n.toFixed(3));
const mean = (xs: number[]): number | null =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

export function AdminConjectureScoresSurface({ navigate }: { navigate: (to: string) => void }) {
  const q = useQuery({
    queryKey: ['admin-conjecture-scores'],
    queryFn: () => apiJson<ConjectureScoresResponse>('/api/admin/conjecture-scores'),
  });
  const data = q.data;

  const link = (to: string, label: string) => (
    <a
      key={to}
      href={to}
      onClick={(e) => {
        e.preventDefault();
        navigate(to);
      }}
    >
      {label}
    </a>
  );

  const scores = data?.prediction_scores ?? [];
  const typed = data?.typed_states ?? [];
  const diagnostics = data?.diagnostics;
  const diagnosticWarnings = diagnostics
    ? [
        ['prediction scores', diagnostics.prediction_scores] as const,
        ['typed states', diagnostics.typed_states] as const,
      ].filter(([, d]) => d.dropped_count > 0 || d.scan_truncated)
    : [];
  // Brier 两侧只在同一批 complete-case 行上聚合，避免 nullable 字段让 model/baseline
  // 使用不同分母，制造方向相反的视觉比较。
  const pairedBrier = scores.flatMap((s) =>
    s.brier_model === null || s.brier_baseline === null
      ? []
      : [{ model: s.brier_model, baseline: s.brier_baseline }],
  );
  const meanBrierModel = mean(pairedBrier.map((s) => s.model));
  const meanBrierBaseline = mean(pairedBrier.map((s) => s.baseline));
  const openStates = typed.filter((t) => t.lifecycle === 'open').length;
  // 诚实：skill_score_point 是**退化的单点值**（scoring.ts），把它逐条平均去下「beats baseline」判词 =
  // 伪造那个被 DEFER 的窗口聚合（真·window BSS = 1 − mean(BS_m)/mean(BS_base)，Rust-owned + ADR-0046）。
  // 故本页**不**在摘要下窗口级胜负判词——window skill 显式标「deferred」，逐条 skill 仅在表里原样列。

  return (
    <main className="page wide">
      <PageHeader
        title="Conjecture Scores"
        eyebrow="ADMIN · conjecture wire"
        sub="备课台预测 vs 真实作答的逐条 proper-score 校准锚 + reconcile 自动铸的 confused-with-X 软轨态。夜间 research_meeting reconcile 累积。"
      >
        <div style={linkRowStyle}>{NAV.map((n) => link(n.to, n.label))}</div>
      </PageHeader>

      {/* 诚实栏（spec §6 S4）：single-point proper score，别读成准确率/窗口均值。 */}
      <div style={honestyRowStyle}>
        <Badge tone="neutral">
          score_basis = {data?.score_basis ?? 'single_point'} · single-point proper score · NOT
          accuracy · NOT window mean
        </Badge>
      </div>

      {data && (
        <div className="kpi-strip">
          <Kpi label="predictions" value={scores.length} note="scored probes" />
          {/* 描述性 mean Brier（越低越好，reader 自比 model vs baseline）；空数据集 dash，不把 0 当真值。 */}
          <Kpi
            label="mean Brier"
            value={fmt(meanBrierModel)}
            note={
              meanBrierBaseline === null
                ? undefined
                : `baseline ${fmt(meanBrierBaseline)} · paired n=${pairedBrier.length}`
            }
          />
          {/* window skill（真·beats-baseline 判词）DEFER 给 Rust window 聚合（ADR-0046）——本页不伪造。 */}
          <Kpi label="window skill" value="deferred" note="window BSS · ADR-0046" />
          <Kpi label="typed states" value={typed.length} note={`${openStates} open`} />
        </div>
      )}

      {/* biome-ignore lint/a11y/useSemanticElements: output only permits phrasing content, but this status contains a Card/list. */}
      <div role="status" aria-live="polite" aria-atomic="true">
        {diagnosticWarnings.length > 0 && (
          <Card>
            <div style={diagnosticAlertStyle}>
              <Badge tone="coral" dot dotStatic>
                data quality
              </Badge>
              <div>
                <strong>部分诊断行未展示</strong>
                <ul style={diagnosticListStyle}>
                  {diagnosticWarnings.map(([label, d]) => (
                    <li key={label}>
                      {label}：扫描 {d.scanned_count} 行，丢弃 {d.dropped_count} 行
                      {d.scan_truncated ? '；已触及有界窗口，结果可能不完整' : ''}。
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </Card>
        )}
      </div>

      <Stateful
        status={q.isLoading ? 'loading' : q.isError ? 'error' : 'ok'}
        onRetry={() => void q.refetch()}
        errorText="conjecture scores 加载失败。"
        skeleton={
          <Card pad="lg">
            <p style={mutedTextStyle}>加载中...</p>
          </Card>
        }
      >
        {data && (
          <>
            <Card pad="lg">
              <div style={sectionHeadStyle}>
                <h2 style={sectionTitleStyle}>prediction scores</h2>
                <Badge tone="neutral">{scores.length} 条</Badge>
              </div>
              {scores.length === 0 ? (
                <p style={mutedTextStyle}>
                  暂无预测评分（reconcile 尚未产出 prediction_score 事件）。
                </p>
              ) : (
                <div style={tableWrapStyle}>
                  <table style={tableStyle}>
                    <thead>
                      <tr>
                        <th style={thStyle}>KC</th>
                        <th style={thStyle}>p̂ vs base</th>
                        <th style={thStyle}>outcome</th>
                        <th style={thStyle}>resolution</th>
                        <th style={thStyle}>Brier m/base</th>
                        <th style={thStyle}>log-loss</th>
                        <th style={thStyle}>skill</th>
                        <th style={thStyle}>R@judge</th>
                        <th style={thStyle}>when</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scores.map((s) => (
                        <tr key={s.event_id}>
                          <td style={tdStyle}>
                            <code>{s.knowledge_id}</code>
                          </td>
                          <td style={tdStyle}>
                            {fmt(s.predicted_p)}{' '}
                            <span style={mutedInline}>/ {fmt(s.baseline_p)}</span>
                          </td>
                          <td style={tdStyle}>
                            <Badge tone={s.outcome === 1 ? 'good' : 'again'}>
                              {s.outcome === 1 ? '答对' : '答错'}
                            </Badge>
                          </td>
                          <td style={tdStyle}>
                            <Badge tone={s.resolution === 'confirmed' ? 'good' : 'neutral'}>
                              {s.resolution}
                            </Badge>
                          </td>
                          <td style={tdStyle}>
                            {fmt(s.brier_model)}{' '}
                            <span style={mutedInline}>/ {fmt(s.brier_baseline)}</span>
                          </td>
                          <td style={tdStyle}>{fmt(s.log_loss_model)}</td>
                          <td style={tdStyle}>
                            <span
                              style={
                                s.skill_score_point !== null && s.skill_score_point > 0
                                  ? okMarkStyle
                                  : undefined
                              }
                            >
                              {fmt(s.skill_score_point)}
                            </span>
                          </td>
                          <td style={tdStyle}>
                            {s.retrievability_at_judge === null
                              ? '—'
                              : fmt(s.retrievability_at_judge)}
                          </td>
                          <td style={tdStyle}>{formatTime(s.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <Card pad="lg">
              <div style={sectionHeadStyle}>
                <h2 style={sectionTitleStyle}>typed states · confused-with-X</h2>
                <Badge tone="neutral">
                  {openStates} open / {typed.length}
                </Badge>
              </div>
              {typed.length === 0 ? (
                <p style={mutedTextStyle}>暂无 confused-with-X 软轨态（reconcile 尚未铸出）。</p>
              ) : (
                <div style={tableWrapStyle}>
                  <table style={tableStyle}>
                    <thead>
                      <tr>
                        <th style={thStyle}>KC</th>
                        <th style={thStyle}>confused with</th>
                        <th style={thStyle}>lifecycle</th>
                        <th style={thStyle}>evidence</th>
                        <th style={thStyle}>last evidence</th>
                      </tr>
                    </thead>
                    <tbody>
                      {typed.map((t) => (
                        <tr key={t.id}>
                          <td style={tdStyle}>
                            <code>{t.knowledge_id}</code>
                          </td>
                          <td style={tdStyle}>
                            {t.confused_with_kc_id ? <code>{t.confused_with_kc_id}</code> : '—'}
                          </td>
                          <td style={tdStyle}>
                            <Badge tone={t.lifecycle === 'open' ? 'coral' : 'good'}>
                              {t.lifecycle}
                            </Badge>
                          </td>
                          <td style={tdStyle}>{t.evidence_event_ids.length}</td>
                          <td style={tdStyle}>{formatTime(t.last_evidence_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </>
        )}
      </Stateful>
    </main>
  );
}

function Kpi({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-num">{value}</div>
      {note && <div className="kpi-trend">{note}</div>}
    </div>
  );
}

// Style authority = sibling admin chrome（镜像 coverage-lattice.tsx inline tokens）。
const linkRowStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 10,
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
};
const honestyRowStyle: CSSProperties = { margin: 'var(--s-2) 0 var(--s-3)' };
const diagnosticAlertStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 'var(--s-3)',
  color: 'var(--ink-2)',
  fontSize: 13,
  lineHeight: 1.55,
};
const diagnosticListStyle: CSSProperties = {
  margin: 'var(--s-1) 0 0',
  paddingLeft: 18,
  color: 'var(--ink-3)',
};
const sectionHeadStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 'var(--s-3)',
  marginBottom: 'var(--s-3)',
};
const sectionTitleStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-serif)',
  fontSize: 20,
  fontWeight: 500,
  letterSpacing: 'var(--ls-tight)',
};
const tableWrapStyle: CSSProperties = { overflowX: 'auto' };
const tableStyle: CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 13 };
const thStyle: CSSProperties = {
  textAlign: 'left',
  padding: '0 10px 8px 0',
  color: 'var(--ink-4)',
  fontFamily: 'var(--font-mono)',
  fontSize: 11.5,
  fontWeight: 500,
};
const tdStyle: CSSProperties = {
  borderTop: '1px solid var(--line-soft)',
  padding: '10px 10px 10px 0',
  verticalAlign: 'top',
  color: 'var(--ink-2)',
  fontFamily: 'var(--font-mono)',
};
const okMarkStyle: CSSProperties = { color: 'var(--good)', fontFamily: 'var(--font-mono)' };
const mutedInline: CSSProperties = { color: 'var(--ink-4)' };
const mutedTextStyle: CSSProperties = {
  margin: 0,
  color: 'var(--ink-3)',
  fontSize: 13,
  lineHeight: 1.55,
};
