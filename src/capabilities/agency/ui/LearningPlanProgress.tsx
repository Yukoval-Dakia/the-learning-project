import { useQuery } from '@tanstack/react-query';
import type { LearningPlanProgress as Progress } from '../server/learning-item-completion-policy';
import './learning-plan-progress.css';

const REASONS: Record<string, string> = {
  item_scope_unverified: '计划范围尚未核实',
  not_leaf: '这项计划包含子计划',
  empty_scope: '尚未绑定知识点',
  unsupported_knowledge_scope: '知识点范围尚未核实',
  missing_knowledge: '知识点不存在',
  purpose_unavailable: '来源当前不可用于学习推导',
  legacy_history: '历史证据暂不支持这项检查',
  unresolved_scope: '部分作答的知识点范围未知',
  unreadable_settlement: '部分判分证据无法核实',
  pending_assessment: '有作答等待判分',
  unsettled_assessment: '有作答等待结算',
  unresolved_appeal: '有复核尚未结束',
  future_evidence: '证据时间尚未核实',
  unreconciled_history: '历史变更尚未核对完成',
  duplicate_contribution: '证据计数尚未核对完成',
  unreadable_snapshot: '掌握记录来源尚未核实',
  unknown_origin: '掌握记录来源尚未核实',
  missing_snapshot: '掌握记录不完整',
  no_observed_mastery: '尚无可用的掌握记录',
  contribution_count_mismatch: '历史贡献尚未核对完成',
  unclosed_beta: '题目难度依据尚未核实',
  invalid_mastery: '掌握范围暂不可用',
  insufficient_independent_evidence: '独立答对证据还不够',
  insufficient_local_days: '需要跨日练习证据',
  stale_evidence: '需要更新练习证据',
  recent_adverse_evidence: '近期仍有错答或部分掌握',
  native_evidence_unavailable: '完成资格证据尚未核实',
  mastery_unavailable: '掌握程度暂不可用',
  mastery_below_threshold: '掌握程度尚未达标',
};
function time(value: string) {
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}
export default function LearningPlanProgress({ read }: { read: () => Promise<Progress> }) {
  const query = useQuery({
    queryKey: ['coach-learning-plan-progress'],
    queryFn: read,
    staleTime: 0,
  });
  return (
    <section className="lp-progress" aria-labelledby="learning-plan-progress-title">
      <header>
        <h2 id="learning-plan-progress-title">学习计划掌握进度</h2>
        <p>逐项看看已经掌握什么，以及还缺哪些练习证据。</p>
      </header>
      {query.isPending && <p role="status">正在读取学习计划…</p>}
      {query.isError && (
        <p role="alert">
          暂时无法读取进度。
          <button type="button" onClick={() => void query.refetch()}>
            重新读取
          </button>
        </p>
      )}
      {query.data && (
        <>
          <p className="lp-progress-note">
            截至 {time(query.data.observedAt)}
            （学习时区：中国标准时间）。这是截至该时刻的初步证据检查，不会自动完成计划。
          </p>
          {!query.data.items.length && <p>还没有进行中的学习计划。</p>}
          <ul className="lp-progress-items">
            {query.data.items.map((item) => (
              <li key={item.id}>
                <div className="lp-progress-heading">
                  <div>
                    <h3>{item.title}</h3>
                    <p className="lp-progress-note">
                      {item.status === 'in_progress' ? '进行中' : '待开始'}
                      {item.userPinned && ' · 已置顶'}
                    </p>
                  </div>
                  <span data-ready={item.eligible}>
                    {item.eligible ? '初步证据已满足' : '仍需证据'}
                  </span>
                </div>
                {item.reasons.length > 0 && (
                  <p>
                    {item.reasons.map((reason) => REASONS[reason] ?? '证据尚未核实').join('；')}
                  </p>
                )}
                <ul className="lp-progress-kcs">
                  {item.knowledge.map((kc) => (
                    <li key={kc.knowledgeId}>
                      <div>
                        <strong>{kc.name ?? '知识点暂不可用'}</strong>
                        <p>
                          {kc.mastery ? (
                            <>
                              <b>{kc.mastery.band}</b> · {Math.round(kc.mastery.point * 100)}% ·
                              模型范围 {Math.round(kc.mastery.lo * 100)}–
                              {Math.round(kc.mastery.hi * 100)}%
                            </>
                          ) : (
                            '掌握程度未知'
                          )}
                        </p>
                        {kc.mastery?.lastOutcomeAt && (
                          <p className="lp-progress-note">
                            最近掌握观测 {time(kc.mastery.lastOutcomeAt)}
                          </p>
                        )}
                      </div>
                      <div>
                        {kc.evidence ? (
                          <p>
                            近 {query.data.policy.windowDays} 天：{kc.evidence.occurrences}{' '}
                            次独立答对，{kc.evidence.anchors} 道不同题，跨 {kc.evidence.localDays}{' '}
                            天{kc.evidence.pending > 0 && `；${kc.evidence.pending} 次待判分`}
                          </p>
                        ) : (
                          <p>证据暂不可用</p>
                        )}
                        {kc.reasons.length > 0 && (
                          <details>
                            <summary>查看尚缺的证据</summary>
                            <ul>
                              {kc.reasons.map((reason) => (
                                <li key={reason}>{REASONS[reason] ?? '证据尚未核实'}</li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <details className="lp-progress-note">
            <summary>初步检查依据</summary>
            <p>
              每个知识点近 {query.data.policy.windowDays} 天至少{' '}
              {query.data.policy.minimumOccurrences} 次不同题目的独立、未受助全对作答，跨至少{' '}
              {query.data.policy.minimumLocalDays} 天，最近一次不超过{' '}
              {query.data.policy.latestHours} 小时，期间没有错答或部分掌握，掌握点估计至少{' '}
              {query.data.policy.minimumMastery * 100}
              %，且全部来源与判分已核实。这是初步运行标准，不是学习效果保证。
            </p>
          </details>
        </>
      )}
    </section>
  );
}
