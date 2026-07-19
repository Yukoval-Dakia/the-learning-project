// YUK-707 (P0F/3) — the single "为你而备" teaching brief band on /today.
//
// Contract (LAW): docs/design/2026-07-19-teaching-brief-contract.md.
// UI design (FINAL, three-lens adjudicated): docs/design/2026-07-19-teaching-brief-ui-design.md.
//
// One default-visible inline band that renders the ONE globally-preferred brief the
// server projected (contract §5). The four contract blocks — finding / basis /
// prepared_action / current_outcome — are real heading/region landmarks (h2 card
// title + h3 per block). It consumes the read model only: accept/dismiss reuse the
// canonical decideProposal pipeline and probe answering reuses the shared
// ProbeAnswerCard — the band itself writes nothing.
//
// Anti-guilt invariants (contract §8.1/§8.2, locked by unit tests): no calibration
// number, no recurrence/backlog/unread/overnight count, no internal id anywhere in the
// DOM (including attributes), evidence is prose-only provenance (never "N 条证据",
// never ×N), and all *_md render as PLAIN TEXT (no markdown renderer), mirroring
// PrepDeskCard / ProbeAnswerCard.

import { Btn } from '@/ui/primitives/Btn';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon, type LoomIconName } from '@/ui/primitives/LoomIcon';
import { SkLines } from '@/ui/primitives/SkLines';
import { Stateful, type StatefulStatus } from '@/ui/primitives/Stateful';
import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { ProbeAnswerCard } from './ProbeAnswers';
import { decideProposal, evidenceReadable } from './inbox-api';
import type { PrepDeskProbeWire } from './probe-answer-api';
import {
  type TeachingBrief,
  ackTeachingBriefOutcome,
  getTeachingBrief,
} from './teaching-brief-api';

// 链式三元被 OCR flag（项目规则禁链式三元）——用 if/else 函数算状态。
function statefulStatus(isLoading: boolean, isError: boolean): StatefulStatus {
  if (isLoading) return 'loading';
  if (isError) return 'error';
  return 'ok';
}

// Forward-only rank for the in-place state advance (design §6 / [裁决 4]): announce +
// move focus ONLY when the SAME brief_id moves finding → probe_ready → outcome.
const STATE_RANK: Record<TeachingBrief['state'], number> = {
  finding: 0,
  probe_ready: 1,
  outcome_confirmed: 2,
  outcome_retired: 2,
};

function outcomeIcon(status: TeachingBrief['current_outcome']['status']): LoomIconName {
  if (status === 'confirmed') return 'check';
  if (status === 'retired') return 'checkCircle';
  return 'sparkle'; // awaiting_decision / awaiting_answer
}

// The three read surfaces whose counts move when a brief advances or retires: the brief
// itself (re-projects to the next state / candidate / null), the overnight digest ribbon,
// and the 待你试做 probe queue. decide() and acknowledge() share this so the invalidation
// set stays in one place (mirrors PrepDeskConjectures' set).
function invalidateBriefSurfaces(qc: QueryClient): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ['teaching-brief'] }),
    qc.invalidateQueries({ queryKey: ['overnight-digest'] }),
    qc.invalidateQueries({ queryKey: ['prep-desk-probes'] }),
  ]);
}

export function TeachingBriefBand() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['teaching-brief'], queryFn: getTeachingBrief });
  const brief = q.data?.brief ?? null;
  const status = statefulStatus(q.isLoading, q.isError);

  // finding accept/dismiss transient state; probe_ready reveal toggle; outcome ack.
  const [deciding, setDeciding] = useState(false);
  const [failed, setFailed] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [acking, setAcking] = useState(false);
  const [ackFailed, setAckFailed] = useState(false);

  // §6 forward-announce: track {brief_id, rank}; the two focus targets are the
  // 「已经为你备好」and 「当前结果」headings.
  const prevRef = useRef<{ brief_id: string; rank: number } | null>(null);
  const preparedHeadingRef = useRef<HTMLHeadingElement>(null);
  const outcomeHeadingRef = useRef<HTMLHeadingElement>(null);
  const [liveMsg, setLiveMsg] = useState('');

  useEffect(() => {
    const prev = prevRef.current;
    // A cleared brief or an identity swap resets per-brief interaction state, so a
    // dismissed finding's error / a stale reveal never bleeds into the next candidate.
    const idChanged = prev === null || prev.brief_id !== (brief?.brief_id ?? null);
    if (idChanged) {
      setRevealed(false);
      setFailed(false);
      setAckFailed(false);
    }
    if (!brief) {
      prevRef.current = null; // null → reset baseline; never announce.
      return;
    }
    const rank = STATE_RANK[brief.state];
    // §6 [裁决 4] — announce + move focus ONLY when the SAME brief_id advances forward.
    const forward = prev !== null && prev.brief_id === brief.brief_id && rank > prev.rank;
    prevRef.current = { brief_id: brief.brief_id, rank }; // always refresh the baseline.
    if (!forward) return; // mount / brief_id swap / no change → no announce, no focus steal.
    setLiveMsg(brief.current_outcome.summary_md); // announce once; evidence never enters here.
    (brief.state === 'probe_ready' ? preparedHeadingRef : outcomeHeadingRef).current?.focus();
  }, [brief]);

  async function decide(decision: 'accept' | 'dismiss') {
    if (!brief || brief.prepared_action.kind !== 'review_finding' || deciding) return;
    setDeciding(true);
    setFailed(false);
    try {
      await decideProposal(brief.prepared_action.proposal_id, decision);
      // accept → re-project to probe_ready; dismiss → next candidate or null.
      await invalidateBriefSurfaces(qc);
    } catch (error) {
      // Contract §7 — keep the current brief, do NOT optimistically advance; allow retry.
      // Redacted diagnostic only (decision + error, never brief/claim/answer payload),
      // mirroring the loader's warn idiom in teaching-brief.ts.
      console.warn('[teaching-brief] decide failed', {
        decision,
        error: error instanceof Error ? error.message : String(error),
      });
      setFailed(true);
    } finally {
      setDeciding(false);
    }
  }

  async function acknowledge() {
    if (!brief || brief.prepared_action.kind !== 'acknowledge_outcome' || acking) return;
    setAcking(true);
    setAckFailed(false);
    try {
      await ackTeachingBriefOutcome(brief.prepared_action.probe_result_event_id);
      // The acked result loses eligibility server-side; re-project to the next candidate
      // or the quiet null (same surfaces as decide).
      await invalidateBriefSurfaces(qc);
    } catch (error) {
      // Contract §7 — keep the current outcome brief, do NOT optimistically dismiss; allow
      // retry. Redacted diagnostic only (never brief/claim/answer payload).
      console.warn('[teaching-brief] acknowledge failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      setAckFailed(true);
    } finally {
      setAcking(false);
    }
  }

  return (
    <div className="tb-band-wrap">
      {/* aria-live region persists across state changes; announced once per forward move. */}
      <div className="tb-live visually-hidden" aria-live="polite">
        {liveMsg}
      </div>
      <Stateful
        status={status}
        onRetry={() => void q.refetch()}
        errorText="教研简报暂不可用。"
        skeleton={
          <div aria-busy="true" aria-label="正在载入教研简报">
            <SkLines rows={4} />
          </div>
        }
      >
        {brief === null ? (
          // Quiet null (contract §6.5): a calm night, NOT "全部完成" / streak / achievement.
          <div className="tb-quiet quiet-empty">教研团暂无需要交付的新判断。</div>
        ) : (
          <LoomCard pad className="prep-desk-card">
            <div className="card-head">
              <span className="card-icon accent">
                <LoomIcon name="teach" size={18} />
              </span>
              <h2 id="tb-title" className="card-title">
                为你而备
              </h2>
            </div>

            {/* 发现 — a falsifiable hypothesis, never "你的弱点就是…" (contract §2.2). */}
            <section className="tb-block" aria-labelledby="tb-h-finding">
              <h3 id="tb-h-finding" className="tb-block-title">
                教研团在检验什么
              </h3>
              <p className="tb-claim serif">{brief.finding.claim_md}</p>
            </section>

            {/* 依据 — summary + prose-only provenance chips (one per ref, no ×N, no ids). */}
            <section className="tb-block" aria-labelledby="tb-h-basis">
              <h3 id="tb-h-basis" className="tb-block-title">
                为什么这么判断
              </h3>
              <p className="tb-basis">{brief.basis.summary_md}</p>
              <div className="tb-evidence">
                {brief.basis.evidence_trace.map((ref, i) => {
                  // Reuse the inbox readable label; IGNORE route (prose-only, never <a>).
                  // key is the index — no raw id ever reaches the DOM (contract §8.2).
                  const readable = evidenceReadable({ kind: ref.kind, id: ref.id });
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: index key is deliberate — raw ids must never touch the DOM.
                    <span key={i} className="pd-ev-chip">
                      <LoomIcon name="link" size={11} /> {readable.text}
                    </span>
                  );
                })}
              </div>
            </section>

            {/* 已经为你备好 — branch on prepared_action.kind (§5). */}
            <section className="tb-block" aria-labelledby="tb-h-prepared">
              <h3
                id="tb-h-prepared"
                ref={preparedHeadingRef}
                tabIndex={-1}
                className="tb-block-title"
              >
                已经为你备好
              </h3>
              <PreparedBlock
                brief={brief}
                revealed={revealed}
                deciding={deciding}
                failed={failed}
                acking={acking}
                ackFailed={ackFailed}
                onReveal={() => setRevealed(true)}
                onAccept={() => void decide('accept')}
                onReject={() => void decide('dismiss')}
                onAcknowledge={() => void acknowledge()}
              />
            </section>

            {/* 当前结果 — reconciliation conclusion + status icon (never colour alone). */}
            <section className="tb-block" aria-labelledby="tb-h-outcome">
              <h3
                id="tb-h-outcome"
                ref={outcomeHeadingRef}
                tabIndex={-1}
                className="tb-block-title"
              >
                当前结果
              </h3>
              <div className={`tb-outcome tb-outcome-${brief.current_outcome.status}`}>
                <LoomIcon name={outcomeIcon(brief.current_outcome.status)} size={14} />
                <span>{brief.current_outcome.summary_md}</span>
              </div>
            </section>
          </LoomCard>
        )}
      </Stateful>
    </div>
  );
}

function PreparedBlock({
  brief,
  revealed,
  deciding,
  failed,
  acking,
  ackFailed,
  onReveal,
  onAccept,
  onReject,
  onAcknowledge,
}: {
  brief: TeachingBrief;
  revealed: boolean;
  deciding: boolean;
  failed: boolean;
  acking: boolean;
  ackFailed: boolean;
  onReveal: () => void;
  onAccept: () => void;
  onReject: () => void;
  onAcknowledge: () => void;
}) {
  if (brief.prepared_action.kind === 'review_finding') {
    return (
      <>
        {/* the UNRUN probe the team is about to ask — preview text, not an answer box. */}
        <div className="pd-probe">
          <div className="pd-probe-lbl">
            <LoomIcon name="sparkle" size={13} /> 团队正要问你的一道题
          </div>
          <div className="pd-probe-md">{brief.prepared_action.probe_preview_md}</div>
        </div>
        {/* accept = acknowledge the VERIFICATION direction, never "确认弱点" / "加进复习". */}
        <div className="tb-actions">
          <Btn size="sm" variant="primary" disabled={deciding} onClick={onAccept}>
            就按这个方向验证
          </Btn>
          <Btn size="sm" variant="ghost" disabled={deciding} onClick={onReject}>
            不太像
          </Btn>
          {failed && (
            <span className="tb-error" role="alert">
              操作失败，请重试
            </span>
          )}
        </div>
      </>
    );
  }

  if (brief.prepared_action.kind === 'answer_probe') {
    const probeWire: PrepDeskProbeWire = {
      probe_question_id: brief.prepared_action.probe_question_id,
      prompt_md: brief.prepared_action.prompt_md,
      knowledge_id: brief.finding.knowledge_id,
    };
    return (
      <>
        {!revealed && (
          <div className="pd-probe">
            <div className="pd-probe-lbl">
              <LoomIcon name="sparkle" size={13} /> 团队正要问你的一道题
            </div>
            <div className="pd-probe-md">{brief.prepared_action.prompt_md}</div>
          </div>
        )}
        <div className="tb-actions">
          {/* reveal the single shared answer card in place (§5.2 · [裁决 3]) — not a
              rebuilt answer flow, not the full multi-probe queue. */}
          <Btn
            size="sm"
            variant="primary"
            aria-expanded={revealed}
            aria-controls="tb-probe-reveal"
            onClick={onReveal}
          >
            现在就试做这道题
          </Btn>
        </div>
        {revealed && (
          <div id="tb-probe-reveal" className="prep-desk-expand">
            <ProbeAnswerCard probe={probeWire} />
          </div>
        )}
      </>
    );
  }

  if (brief.prepared_action.kind === 'acknowledge_outcome') {
    // outcome_* (YUK-708 / contract §4.2) — the probe was answered and reconciled; the
    // conclusion lives in 当前结果 below. The only step left is "知道了", an append-only
    // idempotent ack that retires this result from the brief (never a re-grade, never a
    // guilt/streak beat). On failure keep the outcome + offer a retry (contract §7).
    return (
      <>
        <p className="tb-prepared-done">这道判别题已作答。</p>
        <div className="tb-actions">
          <Btn size="sm" variant="ghost" disabled={acking} onClick={onAcknowledge}>
            知道了
          </Btn>
          {ackFailed && (
            <span className="tb-error" role="alert">
              操作失败，请重试
            </span>
          )}
        </div>
      </>
    );
  }
  // Exhaustive: every prepared_action.kind is handled above; a new kind fails to compile
  // here until it gets its own branch.
  return brief.prepared_action satisfies never;
}
