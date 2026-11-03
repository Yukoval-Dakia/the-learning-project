import { useWorkbenchClient } from './workbench-client';
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
//
// YUK-1473 — M3E presentation (docs/design/2026-11-03-coach-m3e.md): ui-next Button / Chip /
// SkeletonLines, lucide icons, coach-shared-m3e.css. Query, decide, invalidation and the inline
// error handling are unchanged.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GraduationCap, History, Link2, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { PROBE_SLOTS_FULL_CODE } from '@/core/schema/conjecture';

import { ApiError } from '@/ui/lib/api';
import { invalidateAfterProposalDecision, queryKeys } from '@/ui/lib/write-invalidation';
import { SkeletonLines } from '@/ui-next/primitives/SkeletonLines';
import { Button, Chip } from '@/ui-next/public';
import { AreaGate, type AreaStatus } from './AreaGate';
import { type ProposalEvidenceRefWire, dedupeEvidence, evidenceReadable } from './inbox-api';
import type { PrepDeskConjectureWire } from './prep-desk-api';
import './coach-shared-m3e.css';

// 链式三元被 OCR flag（项目规则禁嵌套三元）——同一顺序的 if/else：载入 → 出错 → 有数据。
function statefulStatus(loading: boolean, error: boolean): AreaStatus {
  if (loading) return 'loading';
  if (error) return 'error';
  return 'ok';
}

// YUK-711 — accepting a conjecture serves its probe; when the ≤3 active-probe cap is
// hit the accept rolls back server-side (proposal stays pending) and returns the typed
// `probe_slots_full` wire code. Per teaching-brief contract §7 (accept 交互失败 → 保留
// 当前状态,不乐观转态,允许原位重试,清晰非责备的 inline error) surface a calm, non-blaming
// message that names the retry path — the accept button stays in place to retry.
const PROBE_SLOTS_FULL_MESSAGE = '同时在答的探针题满了，先完成一道，再回来接受这条。';
const DECIDE_FAILED_MESSAGE = '操作失败，请重试';

function decideErrorMessage(err: unknown): string {
  return err instanceof ApiError && err.code === PROBE_SLOTS_FULL_CODE
    ? PROBE_SLOTS_FULL_MESSAGE
    : DECIDE_FAILED_MESSAGE;
}

export function PrepDeskConjectures() {
  const client = useWorkbenchClient();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: queryKeys.prepDeskConjectures,
    queryFn: client.getPrepDeskConjectures,
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
      await client.decideProposal(id, decision);
      // Refreshes this panel, the /today count chip, the 待你试做 queue (an accepted
      // conjecture serves a probe) and the sidebar inbox count.
      await invalidateAfterProposalDecision(qc, { kind: 'conjecture' });
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
    <div className="pc un-m3e-bridge">
      <AreaGate
        status={statefulStatus(q.isLoading, q.isError)}
        onRetry={() => void q.refetch()}
        errorText="备课暂不可用。"
        loading={<SkeletonLines rows={3} label="正在读取备课猜想" />}
      >
        {conjectures.length === 0 ? (
          // (b) calm empty state — never an "all caught up!" achievement nag.
          <p className="cs-quiet">教研团暂无新猜想 —— 你继续学，它会接着为你备。</p>
        ) : (
          <div className="pc-list">
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
      </AreaGate>
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
    <article className="pc-card">
      <p className="cs-kicker">
        <GraduationCap size={16} aria-hidden="true" />
        教研团的猜想 · 为你而备
      </p>

      {/* claim — framed as a hypothesis, not a measurement or a confirmed weakness. */}
      <p className="pc-claim">{c.claim}</p>

      <div className="pc-meta">
        {/* recurrence_count — the one wired number; a failure-cell count, not a probability. */}
        <span className="pc-recur">
          <History size={14} aria-hidden="true" /> {`反复出现 ${c.recurrence_count} 次`}
        </span>
        {c.discriminating && <Chip>尝试区分这一猜想的题</Chip>}
        {c.corrected_by_owner && <Chip tone="accent">你改过</Chip>}
      </div>

      {/* §4 tripwire — the UNRUN probe, framed as "about to ask", NOT a flashcard. */}
      <div className="cs-probe">
        <p className="cs-kicker">
          <Sparkles size={14} aria-hidden="true" /> 团队正要问你的一道题
        </p>
        <div className="cs-probe-md">{c.probe_md}</div>
      </div>

      {evidence.length > 0 && (
        <div className="cs-evidence">
          {evidence.map((de, i) => {
            const r = evidenceReadable(de.ref);
            return (
              <span key={`${de.ref.kind}-${de.ref.id}-${i}`} className="cs-ev">
                <Link2 size={12} aria-hidden="true" /> {r.text}
                {de.count > 1 ? ` ×${de.count}` : ''}
              </span>
            );
          })}
        </div>
      )}

      {/* §3 — accept = acknowledge the DIRECTION, never "加进复习"; reject = 不太像. */}
      <div className="cs-acts">
        <Button size="sm" variant="primary" disabled={deciding} onClick={onAccept}>
          对，往这个方向想
        </Button>
        <Button size="sm" variant="ghost" disabled={deciding} onClick={onReject}>
          不太像
        </Button>
        {failedMessage && (
          <span className="cs-error" role="alert">
            {failedMessage}
          </span>
        )}
      </div>
    </article>
  );
}
