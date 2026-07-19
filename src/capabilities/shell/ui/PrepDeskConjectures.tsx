// YUK-567 slice-1 (教研团 Phase 0 / U4 备课台) — the felt 备课台 conjecture card panel.
// Consumes GET /api/prep-desk/conjectures (≤3 pending conjectures, salience-ranked)
// and surfaces them as the "为你而备" feed: each is the team's hypothesis about a
// misconception, paired with the UNRUN probe it is about to ask.
//
// Contract authority: docs/design/handoff/2026-06-27-prep-desk-conjectures.md.
// Design: docs/design/2026-07-12-prep-desk-card-design.md.
//
// Anti-guilt invariants HARD-CODED here (handoff §2, locked by unit test):
//   (a) NO calibration number rendered — the only number is recurrence_count
//       (a failure-cell count, not a probability). No %, no "把握", no predicted_p.
//   (b) NO backlog / unread count — 0..3 cards, empty = calm, not an achievement nag.
//   (c) NO push / nag styling.
//   §4 tripwire — probe_md framed as "the question the team is about to ask", NEVER
//       a flippable flashcard front/back.
//   §3 ND-5 — accept = acknowledge direction ("对，往这个方向想"), NOT "加进复习";
//       accept/reject route through the canonical /api/proposals/[id]/decisions pipeline.
//
// Slice-1 scope: pending card + accept / reject. EDIT (owner rewrites the claim) is
// deferred — the decide route does not yet thread `corrected_payload`, and the mem0
// CORE writer is a no-op until a later task (conjecture-accept.ts). The post-accept
// probe 作答区 is slice-2.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { ApiError } from '@/ui/lib/api';
import { Btn } from '@/ui/primitives/Btn';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { SkLines } from '@/ui/primitives/SkLines';
import { Stateful, type StatefulStatus } from '@/ui/primitives/Stateful';

import { type ProposalEvidenceRefWire, dedupeEvidence, evidenceReadable } from './inbox-api';
import { decideProposal } from './inbox-api';
import { type PrepDeskConjectureWire, getPrepDeskConjectures } from './prep-desk-api';

function statefulStatus(loading: boolean, error: boolean): StatefulStatus {
  return loading ? 'loading' : error ? 'error' : 'ok';
}

// YUK-711 — accepting a conjecture serves its probe; when the ≤3 active-probe cap is
// hit the accept rolls back server-side (proposal stays pending) and returns the typed
// `probe_slots_full` wire code. Per teaching-brief contract §7 (accept 交互失败 → 保留
// 当前状态,不乐观转态,允许原位重试,清晰非责备的 inline error) surface a calm, non-blaming
// message that names the retry path — the accept button stays in place to retry.
const PROBE_SLOTS_FULL_CODE = 'probe_slots_full';
const PROBE_SLOTS_FULL_MESSAGE = '同时在答的探针题满了，先完成一道，再回来接受这条。';
const DECIDE_FAILED_MESSAGE = '操作失败，请重试';

function decideErrorMessage(err: unknown): string {
  return err instanceof ApiError && err.code === PROBE_SLOTS_FULL_CODE
    ? PROBE_SLOTS_FULL_MESSAGE
    : DECIDE_FAILED_MESSAGE;
}

export function PrepDeskConjectures() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['prep-desk-conjectures'],
    queryFn: getPrepDeskConjectures,
  });
  const [deciding, setDeciding] = useState<Record<string, boolean>>({});
  // Per-card inline error message (empty ⇒ no error). YUK-711: distinguishes the
  // retryable `probe_slots_full` conflict from the generic failure copy.
  const [failed, setFailed] = useState<Record<string, string>>({});
  const conjectures = q.data?.conjectures ?? [];

  async function decide(id: string, decision: 'accept' | 'dismiss') {
    setDeciding((s) => ({ ...s, [id]: true }));
    setFailed((s) => {
      const next = { ...s };
      delete next[id];
      return next;
    });
    try {
      await decideProposal(id, decision);
      // The conjecture leaves the pending set; refresh both the panel and the
      // /today 备课猜想 count chip that gates this panel's entry point.
      await qc.invalidateQueries({ queryKey: ['prep-desk-conjectures'] });
      await qc.invalidateQueries({ queryKey: ['overnight-digest'] });
      // Accepting a conjecture serves a probe → refresh the 待你试做 queue so the new
      // probe appears without a manual reload (codex review-784).
      await qc.invalidateQueries({ queryKey: ['prep-desk-probes'] });
    } catch (err) {
      // A failed decision must NOT silently vanish (CodeRabbit review-782): keep
      // the card and surface a retry affordance instead of an unhandled rejection.
      // YUK-711: the probe-slot-full rollback gets a specific non-blaming message.
      setFailed((s) => ({ ...s, [id]: decideErrorMessage(err) }));
    } finally {
      setDeciding((s) => {
        const next = { ...s };
        delete next[id];
        return next;
      });
    }
  }

  return (
    <div className="prep-desk">
      <Stateful
        status={statefulStatus(q.isLoading, q.isError)}
        onRetry={() => void q.refetch()}
        errorText="备课暂不可用。"
        skeleton={<SkLines rows={3} />}
      >
        {conjectures.length === 0 ? (
          // (b) calm empty state — never an "all caught up!" achievement nag.
          <div className="prep-desk-empty">教研团暂无新猜想 —— 你继续学，它会接着为你备。</div>
        ) : (
          <div className="prep-desk-list">
            {conjectures.map((c) => (
              <PrepDeskCard
                key={c.id}
                c={c}
                deciding={!!deciding[c.id]}
                failedMessage={failed[c.id]}
                onAccept={() => void decide(c.id, 'accept')}
                onReject={() => void decide(c.id, 'dismiss')}
              />
            ))}
          </div>
        )}
      </Stateful>
    </div>
  );
}

function PrepDeskCard({
  c,
  deciding,
  failedMessage,
  onAccept,
  onReject,
}: {
  c: PrepDeskConjectureWire;
  deciding: boolean;
  failedMessage?: string;
  onAccept: () => void;
  onReject: () => void;
}) {
  // Reuse the inbox evidence readability + dedup (route=null kinds fold by prose).
  const evidence = dedupeEvidence(
    c.evidence.map((e) => ({ kind: e.kind as ProposalEvidenceRefWire['kind'], id: e.id })),
  );

  return (
    <LoomCard pad className="prep-desk-card">
      <div className="pd-head">
        <span className="card-icon accent">
          <LoomIcon name="teach" size={18} />
        </span>
        <span className="pd-eyebrow">教研团的猜想 · 为你而备</span>
      </div>

      {/* claim — framed as a hypothesis, not a measurement or a confirmed weakness. */}
      <p className="pd-claim serif">{c.claim}</p>

      <div className="pd-meta">
        {/* recurrence_count — the one wired number; a failure-cell count, not a probability. */}
        <span className="pd-recur">
          <LoomIcon name="history" size={12} /> {`反复出现 ${c.recurrence_count} 次`}
        </span>
        {c.discriminating && <span className="pd-tag">只有这个误区会错的一道题</span>}
        {c.corrected_by_owner && <span className="pd-tag pd-corrected">你改过</span>}
      </div>

      {/* §4 tripwire — the UNRUN probe, framed as "about to ask", NOT a flashcard. */}
      <div className="pd-probe">
        <div className="pd-probe-lbl">
          <LoomIcon name="sparkle" size={13} /> 团队正要问你的一道题
        </div>
        <div className="pd-probe-md">{c.probe_md}</div>
      </div>

      {evidence.length > 0 && (
        <div className="pd-evidence">
          {evidence.map((de, i) => {
            const r = evidenceReadable(de.ref);
            return (
              <span key={`${de.ref.kind}-${de.ref.id}-${i}`} className="pd-ev-chip">
                <LoomIcon name="link" size={11} /> {r.text}
                {de.count > 1 ? ` ×${de.count}` : ''}
              </span>
            );
          })}
        </div>
      )}

      {/* §3 — accept = acknowledge the DIRECTION, never "加进复习"; reject = 不太像. */}
      <div className="pd-actions">
        <Btn size="sm" variant="primary" disabled={deciding} onClick={onAccept}>
          对，往这个方向想
        </Btn>
        <Btn size="sm" variant="ghost" disabled={deciding} onClick={onReject}>
          不太像
        </Btn>
        {failedMessage && (
          <span className="pd-error" role="alert">
            {failedMessage}
          </span>
        )}
      </div>
    </LoomCard>
  );
}
