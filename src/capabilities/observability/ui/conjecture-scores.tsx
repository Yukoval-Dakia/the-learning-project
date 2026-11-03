// YUK-617 mode-1 — conjecture 预测评分只读观测面（admin 第六页）。
//
// 通电既有 GET /api/admin/conjecture-scores（conjecture-wire-spec §6 Q3 verdict-A 明确 specced
// 「admin observe 面 mirror observability four-page」为 S4 交付物——route + 读模型早已落，UI 半从没建，
// 消费路径一直是 curl+jq）。壳形态镜像 coverage-lattice（RootShell admin 页），非独立壳。
//
// 诚实栏（spec §6 S4）：prediction_scores 是 **single-point proper score**（brier/log_loss/skill_score_point
// 逐条判分，NOT accuracy / NOT window mean）——header 显式声明 score_basis，避免误读成准确率或窗口均值。
// typed_states 是 confused-with-X 软轨结构态（provenance = evidence_event_ids）。
// **本轨待通电**（ADR-0050 §(a)；owner 2026-07-25 裁定要通电，执行 YUK-794）：当前 reconcile 是
// kc_typed_state 单写者的唯一生产调用者，它硬编码 confused_with_kc_id=null，而 §修正-4 gate 要求
// 具名 confused-with KC 才发该态，诱导侧 schema 也还没有这个字段——故该栏在 YUK-794 落地前恒空。
// 文案两边都不能写错：早先「reconcile 自动铸」是把未来时写成现在时（反向漂移）；反过来写成
// 「结构性恒空 / 不会铸出」在裁定通电后同样是错的方向。正确措辞是「待通电」。

import { useQuery } from '@tanstack/react-query';
import { Chip } from '@/ui-next/public';
import { type AdminReadClient, httpAdminClient } from './admin-client';
import {
  AdminArea,
  AdminFrame,
  AdminHead,
  AdminKpi,
  AdminKpis,
  AdminNav,
  type AdminNavLink,
  AdminPanel,
  adminAreaStatus,
} from './admin-frame';

type PredictionScoreRow = Awaited<
  ReturnType<AdminReadClient['getConjectureScores']>
>['prediction_scores'][number];

function resolutionTone(
  resolution: PredictionScoreRow['resolution'],
): 'positive' | 'critical' | 'neutral' {
  if (resolution === 'confirmed') return 'positive';
  if (resolution === 'evidence_for') return 'critical';
  return 'neutral';
}
const NAV: AdminNavLink[] = [
  { to: '/admin/runs', label: '运行记录' },
  { to: '/admin/cost', label: '成本' },
  { to: '/admin/failures', label: '失败记录' },
  { to: '/admin/subjects', label: '学科配置' },
  { to: '/admin/coverage-lattice', label: '供题覆盖' },
  { to: '/admin/conjecture-scores', label: '猜想评分' },
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

export function AdminConjectureScoresSurface({
  navigate,
  client = httpAdminClient,
}: {
  navigate: (to: string) => void;
  client?: AdminReadClient;
}) {
  const q = useQuery({
    queryKey: ['admin-conjecture-scores'],
    queryFn: () => client.getConjectureScores(),
  });
  const data = q.data;

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
    <AdminFrame>
      <AdminNav links={NAV} current="/admin/conjecture-scores" navigate={navigate} />
      <AdminHead
        kicker="ADMIN · conjecture wire"
        title="Conjecture Scores"
        lead="备课台预测 vs 真实作答的逐条 proper-score 校准锚（夜间 research_meeting reconcile 累积）。confused-with-X 软轨态待通电，该栏暂空。"
      />

      {/* 诚实栏（spec §6 S4）：single-point proper score，别读成准确率/窗口均值。 */}
      <p className="adm-basis">
        score_basis = {data?.score_basis ?? 'single_point'} · single-point proper score · NOT
        accuracy · NOT window mean
      </p>

      {data && (
        <AdminKpis>
          <AdminKpi label="predictions" value={scores.length} note="scored probes" />
          {/* 描述性 mean Brier（越低越好，reader 自比 model vs baseline）；空数据集 dash，不把 0 当真值。 */}
          <AdminKpi
            label="mean Brier"
            value={fmt(meanBrierModel)}
            note={
              meanBrierBaseline === null
                ? undefined
                : `baseline ${fmt(meanBrierBaseline)} · paired n=${pairedBrier.length}`
            }
          />
          {/* window skill（真·beats-baseline 判词）DEFER 给 Rust window 聚合（ADR-0046）——本页不伪造。 */}
          <AdminKpi label="window skill" value="deferred" note="window BSS · ADR-0046" />
          <AdminKpi label="typed states" value={typed.length} note={`${openStates} open`} />
        </AdminKpis>
      )}

      {/* A div, not <output>: output only permits phrasing content, and this status holds a list. */}
      <div className="adm-live" role="status" aria-live="polite" aria-atomic="true">
        {diagnosticWarnings.length > 0 && (
          <div className="adm-quality">
            <Chip tone="caution">data quality</Chip>
            <div>
              <strong className="adm-quality-title">部分诊断行未展示</strong>
              <ul className="adm-quality-list">
                {diagnosticWarnings.map(([label, d]) => (
                  <li key={label}>
                    {label}：扫描 {d.scanned_count} 行，丢弃 {d.dropped_count} 行
                    {d.scan_truncated ? '；已触及有界窗口，结果可能不完整' : ''}。
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>

      <AdminArea
        status={adminAreaStatus(q)}
        onRetry={() => void q.refetch()}
        errorText="conjecture scores 加载失败。"
        loadingLabel="加载中"
      >
        {data && (
          <>
            <AdminPanel
              id="adm-cj-scores"
              title="prediction scores"
              flush={scores.length > 0}
              aside={<Chip>{scores.length} 条</Chip>}
            >
              {scores.length === 0 ? (
                <p className="adm-empty">
                  暂无预测评分（reconcile 尚未产出 prediction_score 事件）。
                </p>
              ) : (
                <div className="adm-table-scroll">
                  <table className="adm-table adm-table-mono">
                    <thead>
                      <tr>
                        <th scope="col">KC</th>
                        <th scope="col">p̂ vs base</th>
                        <th scope="col">outcome</th>
                        <th scope="col">resolution</th>
                        <th scope="col">Brier m/base</th>
                        <th scope="col">log-loss</th>
                        <th scope="col">skill</th>
                        <th scope="col">R@judge</th>
                        <th scope="col">when</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scores.map((s) => (
                        <tr key={s.event_id}>
                          <td>
                            <code>{s.knowledge_id}</code>
                          </td>
                          <td>
                            {fmt(s.predicted_p)}{' '}
                            <span className="adm-quiet">/ {fmt(s.baseline_p)}</span>
                          </td>
                          <td>
                            <Chip tone={s.outcome === 1 ? 'positive' : 'critical'}>
                              {s.outcome === 1 ? '答对' : '答错'}
                            </Chip>
                          </td>
                          <td>
                            <Chip tone={resolutionTone(s.resolution)}>{s.resolution}</Chip>
                          </td>
                          <td>
                            {fmt(s.brier_model)}{' '}
                            <span className="adm-quiet">/ {fmt(s.brier_baseline)}</span>
                          </td>
                          <td>{fmt(s.log_loss_model)}</td>
                          <td>
                            <span
                              className={
                                s.skill_score_point !== null && s.skill_score_point > 0
                                  ? 'adm-good'
                                  : undefined
                              }
                            >
                              {fmt(s.skill_score_point)}
                            </span>
                          </td>
                          <td>
                            {s.retrievability_at_judge === null
                              ? '—'
                              : fmt(s.retrievability_at_judge)}
                          </td>
                          <td className="adm-quiet">{formatTime(s.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </AdminPanel>

            <AdminPanel
              id="adm-cj-typed"
              title="typed states · confused-with-X"
              flush={typed.length > 0}
              aside={
                <>
                  <Chip tone="caution">本轨待通电</Chip>
                  <Chip>
                    {openStates} open / {typed.length}
                  </Chip>
                </>
              }
            >
              {typed.length === 0 ? (
                <p className="adm-empty">
                  本轨待通电（YUK-794 执行中）：当前还没有写者能产出 confused-with-X——reconcile
                  硬编码 confused_with_kc_id=null，§修正-4 gate 要求具名 KC，诱导侧尚未产出该 KC。
                  故本栏暂空。注意：空 ≠ 「没有混淆」，只是这条轨还没通。详见 ADR-0050 §(a)。
                </p>
              ) : (
                <div className="adm-table-scroll">
                  <table className="adm-table adm-table-mono">
                    <thead>
                      <tr>
                        <th scope="col">KC</th>
                        <th scope="col">confused with</th>
                        <th scope="col">lifecycle</th>
                        <th scope="col">evidence</th>
                        <th scope="col">last evidence</th>
                      </tr>
                    </thead>
                    <tbody>
                      {typed.map((t) => (
                        <tr key={t.id}>
                          <td>
                            <code>{t.knowledge_id}</code>
                          </td>
                          <td>
                            {t.confused_with_kc_id ? <code>{t.confused_with_kc_id}</code> : '—'}
                          </td>
                          <td>
                            <Chip tone={t.lifecycle === 'open' ? 'caution' : 'positive'}>
                              {t.lifecycle}
                            </Chip>
                          </td>
                          <td>{t.evidence_event_ids.length}</td>
                          <td className="adm-quiet">{formatTime(t.last_evidence_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </AdminPanel>
          </>
        )}
      </AdminArea>
    </AdminFrame>
  );
}
