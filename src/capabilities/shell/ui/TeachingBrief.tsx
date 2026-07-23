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

import { learnerLocalDay } from '@/core/learner-day';
import { scopedPracticeHref } from '@/ui/lib/routes';
import { Btn } from '@/ui/primitives/Btn';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon, type LoomIconName } from '@/ui/primitives/LoomIcon';
import { SkLines } from '@/ui/primitives/SkLines';
import { Stateful, type StatefulStatus } from '@/ui/primitives/Stateful';
import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ProbeAnswerCard } from './ProbeAnswers';
import { decideProposal, evidenceReadable } from './inbox-api';
import type { PrepDeskProbeWire } from './probe-answer-api';
import {
  type TeachingBrief,
  ackTeachingBriefOutcome,
  getTeachingBrief,
} from './teaching-brief-api';
import { reportBriefInteraction } from './teaching-brief-interaction-api';

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
async function invalidateBriefSurfaces(qc: QueryClient): Promise<void> {
  // A precise typed return (not the former `Promise<unknown>`); `await` collapses the
  // three void invalidations to void. (`Promise<void[]>` would trip biome's
  // noConfusingVoidType, whose `undefined[]` autofix doesn't typecheck.)
  await Promise.all([
    qc.invalidateQueries({ queryKey: ['teaching-brief'] }),
    qc.invalidateQueries({ queryKey: ['overnight-digest'] }),
    qc.invalidateQueries({ queryKey: ['prep-desk-probes'] }),
  ]);
}

// YUK-710 — the client-side brief_seen suppression key. It MUST be `brief_id × learner-local day`
// (the SAME grain as the server's idempotency + the report's funnel), never brief_id alone: a tab
// left open across the Asia/Shanghai midnight must re-report the SAME brief on the new day (else that
// day's open is never counted and its action becomes unpaired). Reuses learnerLocalDay so the client
// never rederives a timezone. Exported pure for unit testing the day-boundary re-fire.
export function nextBriefSeenState(
  prevKey: string | null,
  briefId: string,
  now: Date,
): { report: boolean; key: string } {
  const key = `${briefId}|${learnerLocalDay(now)}`;
  return { report: key !== prevKey, key };
}

export function TeachingBriefBand({ navigate }: { navigate: (to: string) => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['teaching-brief'], queryFn: getTeachingBrief });
  const brief = q.data?.brief ?? null;
  const status = statefulStatus(q.isLoading, q.isError);

  // finding accept/dismiss transient state; probe_ready reveal toggle; outcome ack.
  const [deciding, setDeciding] = useState(false);
  const [failed, setFailed] = useState(false);
  const [editingClaim, setEditingClaim] = useState(false);
  const [claimDraft, setClaimDraft] = useState('');
  const editClaimTriggerRef = useRef<HTMLButtonElement>(null);
  const [revealed, setRevealed] = useState(false);
  const [acking, setAcking] = useState(false);
  const [ackFailed, setAckFailed] = useState(false);

  // §6 forward-announce: track {brief_id, rank}; the two focus targets are the
  // 「已经为你备好」and 「当前结果」headings.
  const prevRef = useRef<{ brief_id: string; rank: number } | null>(null);
  const preparedHeadingRef = useRef<HTMLHeadingElement>(null);
  const outcomeHeadingRef = useRef<HTMLHeadingElement>(null);
  const [liveMsg, setLiveMsg] = useState('');
  // Latest on-screen brief_id, so an in-flight decide/ack that resolves after a brief swap
  // does not land its failure on the brief the user is now looking at.
  const latestBriefIdRef = useRef<string | null>(null);
  // YUK-710 — last-reported brief_seen key (brief_id × learner-local day); see nextBriefSeenState.
  const briefSeenKeyRef = useRef<string | null>(null);

  // YUK-710 — report a "brief opened" once per brief × learner-local day. Shared by the [brief]
  // effect (mount / swap / same-brief state advance) and the visibilitychange listener (returning
  // to the tab), so a still-on-screen brief re-counts after the Asia/Shanghai day rolls over. The
  // key gate makes every extra trigger a no-op within the same day; the server is idempotent too.
  const fireSeenIfNew = useCallback((b: TeachingBrief) => {
    const seen = nextBriefSeenState(briefSeenKeyRef.current, b.brief_id, new Date());
    briefSeenKeyRef.current = seen.key;
    if (seen.report) {
      reportBriefInteraction({ type: 'brief_seen', brief_id: b.brief_id, brief_state: b.state });
    }
  }, []);

  useEffect(() => {
    const prev = prevRef.current;
    // A cleared brief or an identity swap resets per-brief interaction state, so a
    // dismissed finding's error / a stale reveal never bleeds into the next candidate.
    const idChanged = prev === null || prev.brief_id !== (brief?.brief_id ?? null);
    latestBriefIdRef.current = brief?.brief_id ?? null;
    if (idChanged) {
      // Clear ALL per-brief interaction state (loading + error, both decide and ack) so a
      // prior candidate's spinner / error never bleeds onto the next one.
      setRevealed(false);
      setFailed(false);
      setEditingClaim(false);
      setClaimDraft('');
      setAckFailed(false);
      setDeciding(false);
      setAcking(false);
    }
    if (!brief) {
      prevRef.current = null; // null → reset baseline; never announce.
      return;
    }
    // YUK-710 — record the "opened a delivered brief" funnel signal (once per brief × learner-local
    // day; see fireSeenIfNew). Fires on mount / brief swap / same-brief state advance; the day-key
    // gate suppresses the same-day repeats, and the visibilitychange effect below covers the case of
    // an idle tab crossing Asia/Shanghai midnight (this [brief] effect alone would not re-run then).
    fireSeenIfNew(brief);
    const rank = STATE_RANK[brief.state];
    // §6 [裁决 4] — announce + move focus ONLY when the SAME brief_id advances forward.
    const forward = prev !== null && prev.brief_id === brief.brief_id && rank > prev.rank;
    prevRef.current = { brief_id: brief.brief_id, rank }; // always refresh the baseline.
    if (!forward) return; // mount / brief_id swap / no change → no announce, no focus steal.
    setLiveMsg(brief.current_outcome.summary_md); // announce once; evidence never enters here.
    (brief.state === 'probe_ready' ? preparedHeadingRef : outcomeHeadingRef).current?.focus();
  }, [brief, fireSeenIfNew]);

  // YUK-710 — an idle tab crossing Asia/Shanghai midnight never re-runs the [brief] effect, so on
  // its own the same-brief new-day open would be missed. Returning to the tab (visibilitychange →
  // visible) IS the moment a "brief opened" should count, so re-evaluate the seen-key then; the
  // day-key gate keeps a same-day return a no-op.
  useEffect(() => {
    if (!brief) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') fireSeenIfNew(brief);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [brief, fireSeenIfNew]);

  async function decide(decision: 'accept' | 'dismiss', correctedClaimMd?: string) {
    if (!brief || brief.prepared_action.kind !== 'review_finding' || deciding) return;
    const targetId = brief.brief_id;
    // YUK-710 — interacting with the brief PROVES it was opened today, so record the seen first.
    // This closes the persistently-visible-across-midnight gap: a tab that stays visible over the
    // Asia/Shanghai day boundary re-runs neither the [brief] effect nor visibilitychange, so without
    // this the accept would write a new-day action with no matching new-day seen (unpaired + the
    // prior day left unconverted). The day-key gate makes it a same-day no-op.
    fireSeenIfNew(brief);
    // accept starts the "verify this direction" primary action (accept_probe).
    // dismiss ("不太像") is a proposal decision, already the canonical `rate` event, so it is
    // NOT re-instrumented here. Fired on click (action STARTED), before the network call.
    if (decision === 'accept') {
      reportBriefInteraction({
        type: 'primary_action_started',
        brief_id: targetId,
        action_kind: 'accept_probe',
      });
    }
    setDeciding(true);
    setFailed(false);
    try {
      if (correctedClaimMd) {
        await decideProposal(brief.prepared_action.proposal_id, decision, { correctedClaimMd });
      } else {
        await decideProposal(brief.prepared_action.proposal_id, decision);
      }
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
      // Only surface the failure if THIS brief is still on screen — a swap since the click
      // means the error belongs to a candidate the user no longer sees.
      if (latestBriefIdRef.current === targetId) setFailed(true);
    } finally {
      if (latestBriefIdRef.current === targetId) setDeciding(false);
    }
  }

  async function acknowledge() {
    if (!brief || acking) return;
    // Both outcome states carry the ack target on current_outcome. Confirmed's
    // prepared_action is now practice_scoped (YUK-709), so gate on the outcome status
    // rather than the action kind; non-outcome briefs have nothing to acknowledge.
    if (
      brief.current_outcome.status !== 'confirmed' &&
      brief.current_outcome.status !== 'retired'
    ) {
      return;
    }
    const targetId = brief.brief_id;
    // YUK-710 — the ack is counted as an action in the report funnel, so guarantee today's seen
    // first (same persistently-visible-across-midnight guard as decide; day-key gate = same-day no-op).
    fireSeenIfNew(brief);
    setAcking(true);
    setAckFailed(false);
    try {
      await ackTeachingBriefOutcome(brief.current_outcome.probe_result_event_id);
      // The acked result loses eligibility server-side; re-project to the next candidate
      // or the quiet null (same surfaces as decide).
      await invalidateBriefSurfaces(qc);
    } catch (error) {
      // Contract §7 — keep the current outcome brief, do NOT optimistically dismiss; allow
      // retry. Redacted diagnostic only (never brief/claim/answer payload).
      console.warn('[teaching-brief] acknowledge failed', {
        brief_id: targetId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Guard against a brief swap mid-flight (same parity as decide).
      if (latestBriefIdRef.current === targetId) setAckFailed(true);
    } finally {
      if (latestBriefIdRef.current === targetId) setAcking(false);
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
              {brief.prepared_action.kind === 'review_finding' &&
                (editingClaim ? (
                  <div className="tb-claim-edit">
                    <label htmlFor="tb-claim-edit">改写后的判断</label>
                    <textarea
                      id="tb-claim-edit"
                      value={claimDraft}
                      maxLength={280}
                      disabled={deciding}
                      onChange={(event) => setClaimDraft(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key !== 'Escape' || deciding) return;
                        setEditingClaim(false);
                        setFailed(false);
                        requestAnimationFrame(() => editClaimTriggerRef.current?.focus());
                      }}
                    />
                    <div className="tb-actions">
                      <Btn
                        size="sm"
                        variant="primary"
                        disabled={
                          deciding ||
                          claimDraft.trim().length === 0 ||
                          claimDraft.trim() === brief.finding.claim_md.trim()
                        }
                        onClick={() => void decide('accept', claimDraft.trim())}
                      >
                        保存并验证
                      </Btn>
                      <Btn
                        size="sm"
                        variant="ghost"
                        disabled={deciding}
                        onClick={() => {
                          setEditingClaim(false);
                          setFailed(false);
                          requestAnimationFrame(() => editClaimTriggerRef.current?.focus());
                        }}
                      >
                        取消
                      </Btn>
                      {failed && (
                        <span className="tb-error" role="alert">
                          操作失败，请重试
                        </span>
                      )}
                    </div>
                  </div>
                ) : (
                  <Btn
                    ref={editClaimTriggerRef}
                    size="sm"
                    variant="ghost"
                    disabled={deciding}
                    onClick={() => {
                      setClaimDraft(brief.finding.claim_md);
                      setFailed(false);
                      setEditingClaim(true);
                    }}
                  >
                    改写判断
                  </Btn>
                ))}
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
                navigate={navigate}
                revealed={revealed}
                deciding={deciding}
                failed={editingClaim ? false : failed}
                acking={acking}
                ackFailed={ackFailed}
                onReveal={() => {
                  // YUK-710 — clicking reveal proves the brief was opened today; record the seen
                  // first (same across-midnight guard as decide/acknowledge; day-key gate = no-op).
                  fireSeenIfNew(brief);
                  // The reveal button stays mounted after revealing (it toggles aria-expanded), so
                  // guard on !revealed: a repeat click must not re-fire the answer_probe POST.
                  if (revealed) return;
                  // Revealing the answer card starts the answer_probe primary action.
                  if (brief.prepared_action.kind === 'answer_probe') {
                    reportBriefInteraction({
                      type: 'primary_action_started',
                      brief_id: brief.brief_id,
                      action_kind: 'answer_probe',
                    });
                  }
                  setRevealed(true);
                }}
                onAccept={() => void decide('accept')}
                onReject={() => void decide('dismiss')}
                onAcknowledge={() => void acknowledge()}
                reportSeen={() => fireSeenIfNew(brief)}
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

// The append-only "知道了" ack + its fail-closed inline retry (contract §4.2/§7). Shared by
// both outcome branches (confirmed's practice_scoped and retired's acknowledge_outcome) so
// the dismiss affordance is defined once.
function AckDismiss({
  acking,
  ackFailed,
  onAcknowledge,
}: {
  acking: boolean;
  ackFailed: boolean;
  onAcknowledge: () => void;
}) {
  return (
    <>
      <Btn size="sm" variant="ghost" disabled={acking} onClick={onAcknowledge}>
        知道了
      </Btn>
      {ackFailed && (
        <span className="tb-error" role="alert">
          操作失败，请重试
        </span>
      )}
    </>
  );
}

function PreparedBlock({
  brief,
  navigate,
  revealed,
  deciding,
  failed,
  acking,
  ackFailed,
  onReveal,
  onAccept,
  onReject,
  onAcknowledge,
  reportSeen,
}: {
  brief: TeachingBrief;
  navigate: (to: string) => void;
  revealed: boolean;
  deciding: boolean;
  failed: boolean;
  acking: boolean;
  ackFailed: boolean;
  onReveal: () => void;
  onAccept: () => void;
  onReject: () => void;
  onAcknowledge: () => void;
  // YUK-710 — record today's brief_seen before a tracked action (across-midnight guard).
  reportSeen: () => void;
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

  if (brief.prepared_action.kind === 'practice_scoped') {
    // outcome_confirmed (YUK-709 / contract §9) — the probe supported the judgement. The
    // single primary next step is KC-scoped practice on the confirmed point, reusing the
    // existing on-demand scoped session (YUK-535) via /practice?kc=<id>. This is pure
    // navigation: no practice state is written until the user acts, and the copy promises
    // "练一组" (a set), never a specific count of pre-built questions — an empty/archived KC
    // degrades honestly on the practice page itself (contract §9 / acceptance 4). The
    // append-only "知道了" ack stays as the secondary dismiss (contract §4.2).
    const { knowledge_id, probe_result_event_id } = brief.prepared_action;
    return (
      <>
        <p className="tb-prepared-done">这道判别题已作答，判断得到支持。</p>
        <div className="tb-actions">
          <Btn
            size="sm"
            variant="primary"
            icon="review"
            onClick={() => {
              // YUK-710 — clicking proves today's open; record the seen first (across-midnight
              // guard: a tab visible over the day boundary would otherwise write this new-day action
              // with no matching new-day seen). The day-key gate makes it a same-day no-op.
              reportSeen();
              // Starting KC-scoped practice is the confirmed outcome's primary action.
              // result_event_id links this start back to its probe_result so the report can
              // compute the confirmed → scoped-practice rate. Fired before navigating away.
              reportBriefInteraction({
                type: 'primary_action_started',
                brief_id: brief.brief_id,
                action_kind: 'scoped_practice',
                result_event_id: probe_result_event_id,
              });
              navigate(scopedPracticeHref(knowledge_id));
            }}
          >
            针对这个点练一组
          </Btn>
          <AckDismiss acking={acking} ackFailed={ackFailed} onAcknowledge={onAcknowledge} />
        </div>
      </>
    );
  }

  if (brief.prepared_action.kind === 'acknowledge_outcome') {
    // outcome_retired (YUK-708/709 / contract §2.2 · §4.2 · §9) — the probe ruled the
    // finding out; nothing more is prepared and NO extra practice is created. The main step
    // is to continue the original plan (back to the planned daily practice, no KC scope),
    // with the append-only "知道了" ack to dismiss. On failure keep the outcome + retry
    // (contract §7).
    return (
      <>
        <p className="tb-prepared-done">这道判别题已作答，这条判断已排除。</p>
        <div className="tb-actions">
          <Btn size="sm" variant="primary" icon="review" onClick={() => navigate('/practice')}>
            回到今日练习
          </Btn>
          <AckDismiss acking={acking} ackFailed={ackFailed} onAcknowledge={onAcknowledge} />
        </div>
      </>
    );
  }
  // Exhaustive: every prepared_action.kind is handled above; a new kind fails to compile
  // here until it gets its own branch.
  return brief.prepared_action satisfies never;
}
