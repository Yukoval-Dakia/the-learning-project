import { useRef, useState } from 'react';
import { z } from 'zod';
import {
  GroupEvidence,
  type GroupEvidenceT,
  PracticeIssuanceDto,
  ResponseSet,
  type ResponseSetT,
} from '@/core/schema/assessment';
import { ResponseSlotField, nativeSlotFieldSpec } from '@/ui/components/response/ResponseSlotField';
import {
  type EvidenceAttachment,
  nativeResponseEntry,
  nativeResponseValue,
} from '@/ui/components/response/response-types';
import { StimulusFigure } from '@/ui/components/response/StimulusFigure';
import { MathMarkdown } from '@/ui/lib/math-markdown';
import { Button } from '@/ui-next/public';
import { PresentationBlocks, parsePresentation } from './blocks/PresentationBlocks';
import { type PracticeClient, usePracticeClient } from './practice-client';

export type ConfirmationDraftClient = Pick<
  PracticeClient,
  'getIssuanceState' | 'saveResponseDraft'
>;
export interface ConfirmationAssessmentProps {
  occurrenceId: string;
  sessionId: string;
  assessment: unknown;
  disabled: boolean;
  onSubmit(response: ResponseSetT, evidence: GroupEvidenceT[]): Promise<void>;
  onRefresh(): void;
  client?: ConfirmationDraftClient;
}
const Original = z.object({ response_set: ResponseSet, group_evidence: z.array(GroupEvidence) });
const Issued = z.object({
  practice_dto: PracticeIssuanceDto.nullable(),
  unavailable_reason: z.string().nullable(),
  draft: Original.extend({ save_epoch: z.number().int().nonnegative() }).nullable(),
  submissions: z.array(Original.extend({ submission_id: z.string() })),
});
const Assessment = z.object({
  version: z.literal(1),
  occurrence_id: z.string(),
  session_id: z.string(),
  issuance_id: z.string(),
  revision_id: z.string(),
  submission_id: z.string(),
  evaluation_group_id: z.string(),
  issuance_state: Issued,
  result: z.enum(['issued', 'pending', 'review_required', 'effective', 'failed_pending']),
  submission: Original.extend({
    submission_id: z.string(),
    revision_id: z.string(),
    evaluation_group_id: z.string(),
  }).nullable(),
  candidates: z.array(
    z.object({
      evaluation_id: z.string(),
      status: z.string(),
      aggregate: z.unknown(),
      unit_results: z.unknown(),
    }),
  ),
  effective_head: z.object({ effective_evaluation_id: z.string().nullable() }).nullable(),
  pending_run_id: z.string().nullable(),
  receipts: z.array(
    z.object({ id: z.string(), action: z.string(), payload: z.record(z.string(), z.unknown()) }),
  ),
  independent_mastery: z.literal(false),
  evidence_scope: z.literal('chat_context_unknown'),
  /** YUK-1406 — subject render notation from the server; absent on older snapshots. */
  notation: z.string().nullable().optional(),
});
type Snapshot = z.infer<typeof Assessment>;

export function ConfirmationAssessment(p: ConfirmationAssessmentProps) {
  const defaultClient = usePracticeClient();
  const parsed = Assessment.safeParse(p.assessment);
  if (
    !parsed.success ||
    parsed.data.occurrence_id !== p.occurrenceId ||
    parsed.data.session_id !== p.sessionId
  )
    return <p role="alert">确认题快照不兼容或尚未完整读取。请刷新对话；不会重新发题。</p>;
  const a = parsed.data;
  if (
    a.submission &&
    (a.submission.submission_id !== a.submission_id ||
      a.submission.revision_id !== a.revision_id ||
      a.submission.evaluation_group_id !== a.evaluation_group_id)
  )
    return <p role="alert">作答记录与原题绑定不一致，请刷新原记录。</p>;
  if (
    a.issuance_state.practice_dto &&
    (a.issuance_state.practice_dto.issuance_id !== a.issuance_id ||
      a.issuance_state.practice_dto.revision_id !== a.revision_id)
  )
    return <p role="alert">题目绑定不一致，暂不能作答。</p>;
  return (
    <AssessmentBody key={a.issuance_id} {...p} snapshot={a} client={p.client ?? defaultClient} />
  );
}

function AssessmentBody(
  p: ConfirmationAssessmentProps & { snapshot: Snapshot; client: ConfirmationDraftClient },
) {
  const a = p.snapshot;
  const [responses, setResponses] = useState<ResponseSetT>(
    () => a.submission?.response_set ?? a.issuance_state.draft?.response_set ?? { entries: [] },
  );
  const [evidence, setEvidence] = useState<GroupEvidenceT[]>(
    () => a.submission?.group_evidence ?? a.issuance_state.draft?.group_evidence ?? [],
  );
  const [epoch, setEpoch] = useState(a.issuance_state.draft?.save_epoch ?? 0);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);
  const [uploads, setUploads] = useState<Record<string, boolean>>({});
  const [unreceipted, setUnreceipted] = useState<Record<string, EvidenceAttachment[]>>({});
  const dto = a.issuance_state.practice_dto;
  const presentation = parsePresentation(dto?.presentation);
  const recorded = a.submission !== null || a.issuance_state.submissions.length > 0;
  const locked =
    p.disabled ||
    busy ||
    sent ||
    recorded ||
    a.result !== 'issued' ||
    conflict ||
    !dto ||
    !!a.issuance_state.unavailable_reason;
  const displayResponses = a.submission?.response_set ?? responses;
  const uploadPending =
    Object.values(uploads).some(Boolean) || Object.values(unreceipted).some((v) => v.length > 0);
  const unsupported =
    !!dto &&
    (dto.presentation !== undefined
      ? !presentation
      : dto.response_spec.slots.some((slot) => !nativeSlotFieldSpec(slot)));

  async function saveDraft() {
    if (locked || inFlight.current || uploadPending) return;
    inFlight.current = true;
    setBusy(true);
    setMessage('');
    try {
      const result = await p.client.saveResponseDraft(a.issuance_id, {
        evaluation_group_ref: a.evaluation_group_id,
        response_set: responses,
        group_evidence: evidence,
        expected_save_epoch: epoch,
      });
      setEpoch(result.save_epoch);
      setMessage('草稿已保存；尚未提交判分。');
    } catch (error) {
      setConflict(true);
      setMessage(
        `草稿未确认保存，请先读取原草稿：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function restoreDraft() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const state = Issued.parse(await p.client.getIssuanceState(a.issuance_id));
      if (state.practice_dto && state.practice_dto.issuance_id !== a.issuance_id)
        throw new Error('题目绑定不一致');
      if (state.submissions.length || state.unavailable_reason) {
        setSent(true);
        p.onRefresh();
        setMessage('已读取原提交或不可用状态，请等待对话快照更新。');
        return;
      }
      setResponses(state.draft?.response_set ?? { entries: [] });
      setEvidence(state.draft?.group_evidence ?? []);
      setEpoch(state.draft?.save_epoch ?? 0);
      setConflict(false);
      setMessage('已载入服务端草稿，替换本地未保存内容。');
    } catch (error) {
      setMessage(`读取失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function submit() {
    if (locked || inFlight.current || uploadPending || unsupported) return;
    inFlight.current = true;
    setBusy(true);
    setSent(true);
    try {
      await p.onSubmit(responses, evidence);
      setMessage('提交动作已交给原对话发送链；结果以刷新后的原作答和回执为准。');
    } catch (error) {
      setSent(false);
      setMessage(
        `提交未被接纳：${error instanceof Error ? error.message : String(error)}。请核对输入；可先读取原记录。`,
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  const effectiveId = a.effective_head?.effective_evaluation_id;
  const candidate = a.candidates.find((c) => c.evaluation_id === effectiveId);
  const effects = effectiveId
    ? a.receipts.filter(
        (r) =>
          r.payload.evaluation_id === effectiveId &&
          (r.action === 'experimental:assessment_activation' ||
            r.action === 'experimental:assessment_settlement'),
      )
    : [];
  const labels = {
    issued: '可以作答',
    pending: '作答已记录，判分处理中',
    review_required: '作答已记录，等待复核',
    effective: '已有当前判分结果',
    failed_pending: '作答或生效结果仍待确认',
  };
  return (
    <div className="un-confirm-assessment">
      <p role="status">{labels[a.result]}</p>
      <p>这道题发生在教学对话中。帮助情况不完全明确，本题结果不代表已证明独立掌握。</p>
      {a.issuance_state.unavailable_reason && (
        <p role="alert">
          题目目前不可作答：{a.issuance_state.unavailable_reason}。保留原题绑定，不自动换题。
        </p>
      )}
      {dto &&
        (presentation ? (
          <PresentationBlocks
            presentation={presentation}
            issued={{ faces: dto.faces, materials: dto.materials, slots: dto.response_spec.slots }}
            entries={displayResponses.entries}
            disabled={locked}
            submitting={busy || sent}
            submitted={recorded}
            onEntriesChange={(update) =>
              setResponses((prev) => ({ entries: update(prev.entries) }))
            }
            onUploadingChange={(id, uploading) =>
              setUploads((prev) => ({ ...prev, [id]: uploading }))
            }
            unreceipted={unreceipted}
            onUnreceiptedChange={(id, items) =>
              setUnreceipted((prev) => ({ ...prev, [id]: items }))
            }
          />
        ) : (
          <>
            {dto.materials.map((m) => (
              <div key={m.material_id}>
                {m.content_md !== undefined ? (
                  <MathMarkdown notation={a.notation ?? null}>{m.content_md}</MathMarkdown>
                ) : (
                  <StimulusFigure assetId={m.asset_id} caption={m.caption} alt={m.alt_text} />
                )}
              </div>
            ))}
            {dto.faces.map((face) => (
              <MathMarkdown key={face.part_id} notation={a.notation ?? null}>
                {face.prompt_md}
              </MathMarkdown>
            ))}
            {dto.response_spec.slots.map((slot) => {
              const spec = nativeSlotFieldSpec(slot);
              if (!spec) return <p key={slot.slot_id}>此输入暂不支持，不能提交。</p>;
              const entry = displayResponses.entries.find((e) => e.slot_id === slot.slot_id);
              return (
                <ResponseSlotField
                  key={slot.slot_id}
                  spec={spec}
                  value={nativeResponseValue(entry)}
                  notation={a.notation ?? null}
                  disabled={locked}
                  label={slot.placement?.label}
                  hotkeys={false}
                  onChange={(value) =>
                    setResponses((prev) => ({
                      entries: [
                        ...prev.entries.filter((e) => e.slot_id !== slot.slot_id),
                        nativeResponseEntry(
                          slot,
                          value,
                          prev.entries.find((e) => e.slot_id === slot.slot_id),
                        ),
                      ],
                    }))
                  }
                />
              );
            })}
          </>
        ))}
      {!recorded && a.result === 'issued' && (
        <div className="un-confirm-actions">
          <Button
            disabled={locked || uploadPending || unsupported}
            onClick={() => void saveDraft()}
          >
            保存草稿
          </Button>
          <Button
            variant="primary"
            disabled={locked || uploadPending || unsupported}
            onClick={() => void submit()}
          >
            提交这道题
          </Button>
          <details>
            <summary>恢复原草稿</summary>
            <p>读取服务端原草稿会替换本地未保存内容，不会重新发题或判分。</p>
            <Button disabled={busy || p.disabled} onClick={() => void restoreDraft()}>
              载入原草稿
            </Button>
          </details>
        </div>
      )}
      {uploadPending && <p role="status">附件尚未取得完整回执，暂不能提交。</p>}
      {message && <p role="status">{message}</p>}
      <Button variant="ghost" onClick={p.onRefresh}>
        读取原作答与回执
      </Button>
      {a.pending_run_id && (
        <p>
          原判分任务：<code>{a.pending_run_id}</code>
        </p>
      )}
      {candidate && (
        <details open>
          <summary>当前有效判分</summary>
          <p>状态：{candidate.status}</p>
          <pre>
            {JSON.stringify(
              { aggregate: candidate.aggregate, unit_results: candidate.unit_results },
              null,
              2,
            )}
          </pre>
        </details>
      )}
      {effects.length > 0 && (
        <details>
          <summary>实际生效回执</summary>
          {effects.map((r) => (
            <div key={r.id}>
              <p>
                <code>{r.id}</code> · {r.action}
              </p>
              <pre>
                {JSON.stringify(
                  {
                    effect: r.payload.effect,
                    effects: r.payload.effects,
                    theta_decision: r.payload.theta_decision,
                  },
                  null,
                  2,
                )}
              </pre>
            </div>
          ))}
        </details>
      )}
      {recorded && (
        <details>
          <summary>原作答及记录引用</summary>
          <p>
            submission：<code>{a.submission_id}</code>
          </p>
          <p>
            当前有效 evaluation：<code>{effectiveId ?? '尚无'}</code>
          </p>
          <pre>
            {JSON.stringify(
              a.submission?.response_set ?? a.issuance_state.submissions[0]?.response_set,
              null,
              2,
            )}
          </pre>
          {a.receipts.map((r) => (
            <p key={r.id}>
              {r.action} · <code>{r.id}</code>
            </p>
          ))}
        </details>
      )}
    </div>
  );
}
