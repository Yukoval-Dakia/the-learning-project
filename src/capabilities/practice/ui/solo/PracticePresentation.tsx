import type { ReactNode } from 'react';
import { AssetEvidencePreview } from '@/ui/components/response/AssetEvidencePreview';
import { EvidenceComposer } from '@/ui/components/response/EvidenceComposer';
import { ResponseSlotField, nativeSlotFieldSpec } from '@/ui/components/response/ResponseSlotField';
import { nativeResponseEntry, nativeResponseValue } from '@/ui/components/response/response-types';
import { ApiError } from '@/ui/lib/api';
import { MathMarkdown } from '@/ui/lib/math-markdown';
import type {
  Action,
  AnswerField,
  Content,
  Material,
  PracticeContentProps,
  Revelation,
  Submission,
} from '@/ui-next/cleanroom-practice/contracts';
import { PracticeContent } from '@/ui-next/cleanroom-practice/PracticePage';
import { PresentationBlocks } from '../blocks/PresentationBlocks';
import { practiceSourceLabel } from '../PfStream';
import type { StreamItem } from '../practice-api';
import {
  type Rating,
  appealEntryAvailable,
  isObjectiveQuestion,
  shouldOfferProcessBox,
  type usePracticeSubmit,
} from '../use-practice-submit';
import { DraftConflictPanel } from './DraftConflictPanel';

type Engine = ReturnType<typeof usePracticeSubmit>;
type Frozen = Extract<Engine['issuance'], { status: 'ready' }>['frozen'];
type Figure = Frozen['materials'][number];
const ratings: readonly Rating[] = ['again', 'hard', 'good'];
const ratingLabels = { again: '再练', hard: '模糊', good: '掌握' };

export interface PracticePresentationProps {
  engine: Engine;
  item: StreamItem;
  pos: number;
  total: number;
  advancing: boolean;
  hotkeysSuspended: boolean;
  reasoningTraceMaxLength: number;
  onBack(): void;
  onDone(): void;
  onHint(): void;
  onQuote(text: string): void;
  onZoom(figure: Figure): void;
  lifecycle: PracticeContentProps['lifecycle'];
  history: ReactNode;
  overlays: ReactNode;
}

/** Projection only: every operation and eligibility decision stays with the existing engine. */
export function PracticePresentation(props: PracticePresentationProps) {
  const { engine, item, pos, total, advancing, onBack, onDone } = props;
  const { question, issuance, draft, conflict, submit, appeal } = engine;
  const { phase, displayedPreview: feedback } = submit;
  const q = question.data;
  const ready = issuance.status === 'ready' ? issuance : null;
  const frozen = ready?.frozen;
  const actions = new Map<string, () => void>();
  const content = new Map<string, ReactNode>();
  const controls = new Map<string, ReactNode>();
  const action = (
    id: string,
    label: string,
    run: () => void,
    enabled = true,
    reason = '当前状态下暂不可用',
  ): Action => {
    actions.set(id, run);
    return {
      id,
      label,
      availability: enabled ? { kind: 'enabled' } : { kind: 'disabled', reason },
    };
  };
  const node = (id: string, label: string, element: ReactNode): Content => {
    content.set(id, element);
    return { id, label, kind: 'text' };
  };
  const markdown = (id: string, label: string, text: string) =>
    node(
      id,
      label,
      <div data-quotable="">
        <MathMarkdown notation={q?.notation ?? null}>{text}</MathMarkdown>
      </div>,
    );
  const back = action(
    'back',
    '返回练习',
    () => (advancing ? onBack() : void engine.handleBack()),
    !submit.returning,
    '正在保存作答',
  );
  const leave = action('leave-unavailable', '返回练习', onBack);
  const view: PracticeContentProps['view'] = {
    identity: item.id,
    page: { kind: 'loading', notice: { title: '正在取题' } },
  };
  let questionBody: ReactNode;
  let hasQuestion = false;
  if (question.query.isError) {
    view.page = {
      kind: 'failed',
      notice: {
        title: '这道题没取到，可能是网络断了一下。',
        actions: [action('reload-question', '再试一次', () => void question.query.refetch()), back],
      },
    };
  } else if (!q) {
    view.page = { kind: 'loading', notice: { title: '正在取题' } };
  } else if (issuance.status === 'pending') {
    view.page = { kind: 'loading', notice: { title: '正在取题' } };
  } else if (issuance.status === 'failed') {
    const selfRate = issuance.error instanceof ApiError && issuance.error.code === 'not_admitted';
    view.page = {
      kind: 'failed',
      notice: {
        title: selfRate
          ? '这道题还不能自动判分。可以照常作答，做完自己评一下，用来安排复习。'
          : '这道题暂时没法在这里作答，可以再试一次，或者先返回练习。',
        actions: [
          selfRate
            ? action('manual-issuance', '按自行评级练习', issuance.startSelfRated)
            : action('retry-issuance', '重试', issuance.retry),
          leave,
        ],
      },
    };
  } else if (!issuance.restored || !frozen || !ready) {
    view.page = { kind: 'recovering', notice: { title: '正在恢复作答' } };
  } else {
    hasQuestion = true;
    const answering = phase === 'answering' && !submit.pendingRun && !submit.answerRecorded;
    const locked =
      submit.returning ||
      phase !== 'answering' ||
      !!ready.accepted ||
      !!submit.pendingRun ||
      !!conflict;
    const mode = locked ? ('readonly' as const) : ('editable' as const);
    const field = (slot: Frozen['response_spec']['slots'][number]): AnswerField[] => {
      const spec = nativeSlotFieldSpec(slot);
      if (!spec) return [];
      const entry = draft.responses.entries.find((value) => value.slot_id === slot.slot_id);
      controls.set(
        slot.slot_id,
        <ResponseSlotField
          spec={spec}
          value={nativeResponseValue(entry)}
          label={slot.placement?.label}
          notation={q.notation}
          disabled={locked}
          onChange={(value) => draft.updateResponse(nativeResponseEntry(slot, value, entry))}
          feedback={phase === 'feedback' ? 'graded' : 'none'}
          hotkeys={
            frozen.response_spec.slots.length === 1 &&
            draft.isChoice &&
            phase === 'answering' &&
            !props.hotkeysSuspended
          }
          ariaLabel={slot.placement?.label ?? '作答'}
        />,
      );
      return [
        {
          id: slot.slot_id,
          kind: 'specialized',
          controlId: slot.slot_id,
          safety: { kind: 'approved', boundaryId: 'existing-native-response-renderer' },
          label: slot.placement?.label ?? '作答',
          mode,
        },
      ];
    };
    const material = (m: Figure): Material => ({
      id: m.material_id,
      title: m.caption ?? (m.kind === 'passage' ? '阅读材料' : '题目材料'),
      state: {
        kind: 'ready',
        content: node(
          m.material_id,
          m.alt_text ?? m.caption ?? '题目材料',
          <figure>
            {m.content_md !== undefined ? (
              <MathMarkdown notation={q.notation}>{m.content_md}</MathMarkdown>
            ) : m.kind === 'figure' || m.kind === 'table' ? (
              <button
                type="button"
                className="un-cr-figure"
                onClick={() => props.onZoom(m)}
                aria-label={`放大看：${m.alt_text ?? m.caption ?? '题目配图'}`}
              >
                <AssetEvidencePreview
                  assetId={m.asset_id}
                  kind="image"
                  label={m.alt_text ?? m.caption ?? '题目配图'}
                />
              </button>
            ) : (
              <AssetEvidencePreview
                assetId={m.asset_id}
                label={m.alt_text ?? m.caption ?? '题目材料'}
              />
            )}
            {m.caption && <figcaption>{m.caption}</figcaption>}
          </figure>,
        ),
      },
    });
    const stemText = frozen.faces.map((face) => face.prompt_md).join('\n');
    const parts =
      frozen.faces.length > 1
        ? frozen.faces.map((face, index) => ({
            id: face.part_id,
            label: face.question_no ?? `第 ${index + 1} 问`,
            stem: markdown(`face:${face.part_id}`, '题干', face.prompt_md),
            materials: [],
            fields: frozen.response_spec.slots
              .filter((slot) => slot.part_id === face.part_id)
              .flatMap(field),
          }))
        : [];
    const fields = frozen.response_spec.slots
      .filter(
        (slot) => parts.length === 0 || !frozen.faces.some((face) => face.part_id === slot.part_id),
      )
      .flatMap(field);
    const extras: ReactNode = (
      <>
        {(!locked || draft.evidence.length > 0) && (
          <EvidenceComposer
            text=""
            onTextChange={() => {}}
            showText={false}
            attachments={draft.evidence}
            onAttachmentsChange={draft.updateEvidence}
            disabled={locked}
            onUploadingChange={draft.setUploading}
            showAddButton
          />
        )}
        {answering && shouldOfferProcessBox(draft.isChoice) && (
          <details>
            <summary>补充思路（可选）</summary>
            <textarea
              rows={3}
              value={submit.reasoningTrace}
              maxLength={props.reasoningTraceMaxLength}
              onChange={(event) => submit.setReasoningTrace(event.target.value)}
              aria-label="解题思路（可选）"
            />
          </details>
        )}
      </>
    );
    if (draft.presentation)
      questionBody = (
        <>
          <PresentationBlocks
            presentation={draft.presentation}
            issued={{
              faces: frozen.faces,
              materials: frozen.materials,
              slots: frozen.response_spec.slots,
            }}
            entries={draft.responses.entries}
            onEntriesChange={draft.updateResponses}
            notation={q.notation}
            disabled={locked}
            submitting={submit.judging || submit.committing}
            submitted={
              !!ready.accepted ||
              submit.answerRecorded ||
              !!submit.pendingRun ||
              phase !== 'answering'
            }
            onUploadingChange={(id, uploading) => draft.trackUpload(`free:${id}`, uploading)}
            unreceipted={draft.unreceipted}
            onUnreceiptedChange={draft.setSlotUnreceipted}
          />
          {submit.customSummary.length > 0 && <p>你的作答：{submit.customSummary.join('；')}</p>}
          {extras}
        </>
      );
    else {
      controls.set('evidence', extras);
      fields.push({
        id: 'evidence',
        kind: 'specialized',
        label: '附件与思路',
        mode,
        controlId: 'evidence',
        safety: { kind: 'approved', boundaryId: 'existing-evidence-receipt-owner' },
      });
    }
    const submission: Submission = {
      recording: { kind: 'idle' },
      grading: { kind: 'idle' },
      secondary: [],
    };
    let revelation: Revelation = { kind: 'concealed' };
    const unknownScore = feedback?.coarse_outcome === 'partial_unknown';
    if (answering) {
      if (ready.mode === 'manual')
        submission.secondary = ratings.map((rating) =>
          action(
            `manual:${rating}`,
            ratingLabels[rating],
            () => void submit.commit({ withAppeal: false, rating }),
            submit.canSubmit && !submit.committing && !advancing,
          ),
        );
      else
        submission.primary = action(
          'submit',
          submit.judging ? '正在判…' : '提交',
          () => void submit.runJudge(),
          submit.canSubmit,
          '请完成作答，或等待当前操作结束',
        );
    }
    if (submit.judging) submission.grading = { kind: 'grading' };
    if (submit.committing) submission.recording = { kind: 'saving' };
    if (submit.answerRecorded && phase === 'answering' && !submit.pendingRun)
      submission.recording = {
        kind: 'saved',
        notice: {
          title: '这道题已经交过了，只能查看当时交的作答，不能再交一次。',
          detail: '结果在作答记录中。',
        },
      };
    else if (submit.pendingRun) {
      submission.recording = { kind: 'saved' };
      submission.grading = {
        kind: 'pending',
        notice: {
          title:
            submit.pendingPoll.status === 'failed' || submit.pendingPoll.error
              ? '判分暂时没跑成。你的作答已经存住，系统会自动补判，不需要重交。'
              : '这份作答在排队判分，不需要重交。可以先做下一题，结果稍后到。',
        },
      };
      submission.primary = action(
        'continue-pending',
        advancing ? '下一题准备中…' : '先继续',
        onDone,
        !advancing,
      );
    } else if (phase === 'confidence') {
      revelation = {
        kind: 'concealed',
        confidence: {
          value: null,
          availability: { kind: 'enabled' },
          skip: action('skip-confidence', '跳过', () => submit.revealVerdict(null)),
        },
      };
    } else if (phase === 'feedback' && feedback) {
      const outcome = feedback.coarse_outcome;
      const unsupported = outcome === 'unsupported';
      submission.grading = { kind: unsupported ? 'manual' : 'settled' };
      if (submit.autoCommitted || submit.committedPreview) submission.recording = { kind: 'saved' };
      revelation = {
        kind: 'revealed',
        result: {
          verdict: unsupported ? 'unknown' : outcome === 'partial_unknown' ? 'partial' : outcome,
          summary: unsupported
            ? '这题暂时没法自动判。'
            : outcome === 'partial_unknown'
              ? `部分正确（${(feedback.partial_units ?? []).map((unit) => `${unit.correct_count}/${unit.total_count}`).join('、')}），分数未知`
              : isObjectiveQuestion(feedback.route)
                ? '自动核对只比较了答案本身，还没有判断原因。'
                : '这是 AI 的判断，觉得不对可以申诉。',
          parts: [],
          reference: q.reference_md
            ? { kind: 'ready', content: markdown('reference', '参考答案', q.reference_md) }
            : { kind: 'missing', reason: '没有可显示的参考答案' },
          evidence:
            !unsupported && feedback.feedback_md
              ? [markdown('feedback', '判分反馈', feedback.feedback_md)]
              : [],
          uncertainty: unknownScore ? '对了几处是确定的；分数还算不出来，不按 0 分记。' : undefined,
        },
      };
      if (!submit.autoCommitted && !unknownScore)
        revelation.selfRating = {
          label: '按这次的情况安排复习',
          value: submit.rating,
          options: ratings.map((id) => ({ id, label: ratingLabels[id] })),
          disabled: false,
          reason: feedback.suggested_rating
            ? `建议：${ratingLabels[feedback.suggested_rating]}`
            : '这次没有建议，自己选一个',
          actions: [],
        };
      if (unsupported && !submit.autoCommitted && !submit.committedPreview)
        submission.secondary = [
          ...submission.secondary,
          action('self-rate', '自己评一下', submit.startSelfRate),
        ];
      submission.primary = submit.autoCommitted
        ? action(
            'next',
            advancing ? '下一题准备中…' : '下一题',
            onDone,
            !submit.committing && !advancing,
          )
        : unknownScore
          ? action(
              'record-unknown',
              '记下作答，下一题',
              () => void submit.commit({ withAppeal: false, rating: 'hard', autoRate: true }),
              !submit.committing && !advancing,
            )
          : action(
              'confirm',
              '确认，下一题',
              () => {
                if (submit.rating) void submit.commit({ withAppeal: false, rating: submit.rating });
              },
              !submit.committing && !advancing && !!submit.rating,
            );
      if (
        appealEntryAvailable({
          phase,
          appealOpen: appeal.open,
          autoCommitted: submit.autoCommitted,
          autoCommitJudgeEventId: submit.autoCommitJudgeEventId,
        })
      )
        submission.secondary = [
          ...submission.secondary,
          action('appeal-open', '觉得判得不对？说明理由重判', () => appeal.setOpen(true)),
        ];
      if (appeal.open)
        revelation.appeal = {
          kind: 'editing',
          field: {
            id: 'appeal',
            label: '重判理由',
            kind: 'text',
            value: appeal.text,
            mode: 'editable',
          },
          notice: {
            title: '重判在后台进行，不耽误做下一题',
            actions: [
              action(
                'appeal-submit',
                '提交重判，先继续',
                () => {
                  if (submit.autoCommitted) void appeal.submitAfterAutoCommit();
                  else if (unknownScore)
                    void submit.commit({ withAppeal: true, rating: 'hard', autoRate: true });
                  else if (submit.rating)
                    void submit.commit({ withAppeal: true, rating: submit.rating });
                },
                !!appeal.text.trim() &&
                  !submit.committing &&
                  !advancing &&
                  (submit.autoCommitted
                    ? !!submit.autoCommitJudgeEventId
                    : !!submit.rating || !!unknownScore),
              ),
              action('appeal-cancel', '算了', () => appeal.setOpen(false)),
            ],
          },
        };
    }
    if (advancing)
      submission.continuation = { kind: 'advancing', notice: { title: '正在准备下一题' } };
    const support = [
      back,
      action('quote-question', '把题目引用到学习伙伴', () => props.onQuote(stemText)),
    ];
    if (!question.isInterventionDiagnostic)
      support.push(action('hint', '需要提示？', props.onHint));
    const saved = draft.autosave.state;
    view.page = {
      kind: 'ready',
      question: {
        id: item.id,
        title: item.knowledge_name ?? q.labels[0]?.name ?? '这道题',
        subject: '练习',
        progressLabel: `第 ${pos} / ${total} 题`,
        estimatedTime: item.estimated_minutes ? `约 ${item.estimated_minutes} 分钟` : undefined,
        source: practiceSourceLabel(item.source),
        attemptLabel:
          ready.accepted || submit.autoCommitted
            ? '已提交'
            : (() => {
                const last = question.timelineEvents.find((event) => event.kind === 'attempt');
                return last?.kind === 'attempt'
                  ? `上次 · ${{ success: '做对了', failure: '没做对', partial: '部分对', pending: '还在判', unsupported: '没法自动判' }[last.outcome]}`
                  : '第一次做';
              })(),
        stem: markdown('stem', '题目', parts.length ? '' : stemText),
        materials: frozen.materials.map(material),
        fields,
        parts,
        draft: conflict
          ? {
              kind: 'conflict',
              notice: { title: '草稿版本有变化，请先处理' },
              local: { id: 'conflict-local', label: '本地版本', kind: 'text' },
              remote: { id: 'conflict-remote', label: '远端版本', kind: 'text' },
            }
          : {
              kind:
                saved === 'error'
                  ? 'failed'
                  : saved === 'conflict'
                    ? 'failed'
                    : saved === 'idle'
                      ? 'empty'
                      : saved,
              notice: {
                title: saved === 'error' ? '保存失败' : saved === 'saved' ? '已保存' : '正在保存',
                actions:
                  saved === 'error' ? [action('save-retry', '重试保存', draft.autosave.retry)] : [],
              },
            },
        submission,
        revelation,
        supportActions: support,
      },
    };
  }
  return (
    <PracticeContent
      view={view}
      intents={{
        action: (id) => actions.get(id)?.(),
        answer: (id, value) => {
          if (id === 'appeal' && typeof value === 'string') appeal.setText(value);
        },
        attach: () => {},
        specializedAnswer: () => {},
        rating: (value) => {
          if (ratings.some((rating) => rating === value)) submit.setRating(value as Rating);
        },
        confidence: submit.revealVerdict,
      }}
      renderers={{
        content: (item) => content.get(item.id),
        answer: (control) => controls.get(control.id),
      }}
      lifecycle={{
        ...props.lifecycle,
        resultRef:
          hasQuestion &&
          ((submit.answerRecorded && phase === 'answering' && !submit.pendingRun) ||
            !!submit.pendingRun ||
            phase === 'confidence' ||
            (phase === 'feedback' && !!feedback) ||
            (phase === 'answering' && submit.judging && !submit.pendingRun))
            ? props.lifecycle?.resultRef
            : undefined,
        issuancePlaceholderRef:
          q && !question.query.isError && issuance.status === 'pending'
            ? issuance.attach
            : undefined,
        answeringRootRef: hasQuestion ? engine.attachPagehideFlush : undefined,
        submitActionsRef:
          hasQuestion && phase === 'answering' && !submit.pendingRun && !submit.answerRecorded
            ? engine.attachSubmitHotkey
            : undefined,
      }}
      surfaces={{
        questionBody,
        conflict: conflict ? <DraftConflictPanel view={conflict} /> : undefined,
        history: props.history,
        overlays: props.overlays,
      }}
    />
  );
}
