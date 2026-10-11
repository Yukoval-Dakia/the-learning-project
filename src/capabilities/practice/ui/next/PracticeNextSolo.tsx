// YUK-1473 — one practice question with the learning companion beside it, in the new design
// language. Checkpoint 2: every state of the page on real data. Submission, judging, appeal and
// drafts run through the same hook as PfSolo (use-practice-submit), so the API calls, query keys
// and idempotency ids are identical; only the rendering is new.
// Rules: docs/design/2026-10-07-ui-visual-direction.md R1, R3, R4, R7, R9, C1–C3, C6, T1–T5,
// M1, M9, M14, A1, A2.

import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { CopilotDock } from '@/capabilities/copilot/ui-public';
import type { PracticeIssuanceDtoT } from '@/core/schema/assessment';
import { REASONING_TRACE_MAX_LEN } from '@/kernel/limits';
import { AssetEvidencePreview } from '@/ui/components/response/AssetEvidencePreview';
import { EvidenceComposer } from '@/ui/components/response/EvidenceComposer';
import { ResponseSlotField, nativeSlotFieldSpec } from '@/ui/components/response/ResponseSlotField';
import { nativeResponseEntry, nativeResponseValue } from '@/ui/components/response/response-types';
import { SaveStateChip } from '@/ui/components/response/SaveStateChip';
import { ApiError } from '@/ui/lib/api';
import { MathMarkdown } from '@/ui/lib/math-markdown';
import {
  BottomSheet,
  Button,
  Chip,
  ChipToggle,
  type ChipTone,
  CompanionPanel,
  Expand,
  PHONE_MEDIA,
  Segmented,
  type SheetSnap,
  Toaster,
  UiNextRoot,
  useToaster,
} from '@/ui-next/public';
import { practiceSourceLabel } from '../PfStream';
import type { StreamItem } from '../practice-api';
import {
  type JudgeFeedback,
  RATING_LABEL,
  type Rating,
  appealEntryAvailable,
  isObjectiveQuestion,
  shouldOfferProcessBox,
  usePracticeSubmit,
} from '../use-practice-submit';
import { FigureLightbox } from './FigureLightbox';
import './practice-next.css';

export type PracticeCompanionMode = 'embedded' | 'none';

export interface PracticeNextSoloProps {
  item: StreamItem;
  sessionId?: string | null;
  pos: number;
  total: number;
  onBack: () => void;
  onDone: () => void;
  onCommittedBack?: () => void;
  /** Route push for links inside companion replies. */
  navigate: (to: string) => void;
  /**
   * `embedded` mounts the Copilot conversation in the companion panel. Only valid when the
   * shell's global Copilot dock is off: the dock owns the open-with-context signal and exactly
   * one may be mounted (CopilotDock `variant`). `none` keeps the honest placeholder.
   */
  companion: PracticeCompanionMode;
}

type MaterialView = PracticeIssuanceDtoT['materials'][number];
type SlotView = PracticeIssuanceDtoT['response_spec']['slots'][number];

const HISTORY_TEXT = {
  success: { label: '做对了', tone: 'positive' },
  failure: { label: '没做对', tone: 'caution' },
  partial: { label: '部分对', tone: 'caution' },
  pending: { label: '还在判', tone: 'neutral' },
  unsupported: { label: '没法自动判', tone: 'neutral' },
} as const satisfies Record<string, { label: string; tone: ChipTone }>;

const RATINGS: readonly Rating[] = ['again', 'hard', 'good'];

function formatDay(sec: number): string {
  const d = new Date(sec * 1000);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function subscribePhone(onChange: () => void) {
  const media = window.matchMedia(PHONE_MEDIA);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}
const readPhone = () => window.matchMedia(PHONE_MEDIA).matches;

/** Plain verdict words (R3): a deterministic check says what it compared and nothing more. */
function verdictWords(p: JudgeFeedback): { label: string; tone: ChipTone; note: string | null } {
  if (p.coarse_outcome === 'unsupported') {
    return { label: '暂时没法自动判', tone: 'neutral', note: null };
  }
  if (isObjectiveQuestion(p.route)) {
    const note = '自动核对的结果：只比较了答案本身，还没有判断原因。';
    if (p.coarse_outcome === 'correct') return { label: '与参考答案一致', tone: 'positive', note };
    if (p.coarse_outcome === 'partial')
      return { label: '和参考答案部分一致', tone: 'caution', note };
    return { label: '与参考答案不一致', tone: 'caution', note };
  }
  const note = '这是 AI 的判断，觉得不对可以申诉。';
  if (p.coarse_outcome === 'correct') return { label: '判为正确', tone: 'positive', note };
  if (p.coarse_outcome === 'partial') return { label: '判为部分正确', tone: 'caution', note };
  return { label: '判为不正确', tone: 'caution', note };
}

/**
 * Why this question can't be answered here, in learner words. Only the typed error code is read,
 * never the message. YUK-1445: when the feature line's serving gate ships typed hold-back reasons,
 * map them here the same way.
 */
function issuanceProblem(error: unknown): { text: string; selfRate: boolean; retry: boolean } {
  const code = error instanceof ApiError ? error.code : null;
  if (code === 'not_admitted') {
    return {
      text: '这道题还不能自动判分。可以照常作答，做完自己评一下，用来安排复习。',
      selfRate: true,
      retry: false,
    };
  }
  if (code === 'suspended' || code === 'withdrawn' || code === 'unpublished') {
    return { text: '这道题暂时停用了，先做别的题吧。', selfRate: false, retry: false };
  }
  return {
    text: '这道题暂时没法在这里作答。可以再试一次，或者先返回练习。',
    selfRate: false,
    retry: true,
  };
}

export function PracticeNextSolo({
  item,
  sessionId,
  pos,
  total,
  onBack,
  onDone,
  onCommittedBack,
  navigate,
  companion,
}: PracticeNextSoloProps) {
  const toaster = useToaster();
  const push = toaster.push;
  const notify = useCallback((text: string) => void push(text), [push]);
  const s = usePracticeSubmit({
    item,
    sessionId,
    onDone,
    onBack,
    onCommittedBack,
    addToast: notify,
  });
  const { q, frozen, phase, displayedPreview } = s;

  // ⌘/Ctrl+Enter submits while answering (same shortcut as PfSolo).
  const { runJudge } = s;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (phase !== 'answering') return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        void runJudge();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, runJudge]);

  const [sheet, setSheet] = useState<SheetSnap>('peek');
  // Transitional: inside the retained shell its fixed phone tab bar would cover the sheet, so the
  // sheet peeks above whatever bottom bar the shell draws (YUK-1473 checkpoint 1, owner decision).
  const [shellInset, setShellInset] = useState(0);
  useLayoutEffect(() => {
    const bar = document.querySelector<HTMLElement>('.mobile-tabbar');
    if (!bar) return;
    const measure = () =>
      setShellInset(getComputedStyle(bar).display === 'none' ? 0 : bar.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(bar);
    return () => ro.disconnect();
  }, []);
  // One Dock instance only: it goes into the panel on wide screens, into the sheet on phones.
  const isPhone = useSyncExternalStore(subscribePhone, readPhone, () => false);
  const [companionBusy, setCompanionBusy] = useState(false);
  const [zoomed, setZoomed] = useState<MaterialView | null>(null);
  const [pane, setPane] = useState<'passage' | 'questions'>('questions');

  const timeline = s.timelineEvents;
  const lastAttempt = [...timeline].reverse().find((e) => e.kind === 'attempt');
  const title = item.knowledge_name ?? q?.labels[0]?.name ?? '这道题';
  const notation = q?.notation ?? null;
  const loading =
    !s.qQ.isError &&
    (!q || s.frozenQ.isLoading || (!!frozen && s.restoredIssuanceId !== s.issuanceId));
  const issuanceFailed = !s.qQ.isError && !loading && (s.frozenQ.isError || !frozen);

  const passages = (frozen?.materials ?? []).filter(
    (m) => m.kind === 'passage' && m.content_md !== undefined,
  );
  const figures = (frozen?.materials ?? []).filter((m) => !passages.includes(m));
  const hasPassage = passages.length > 0;
  const faces = frozen?.faces ?? [];
  const multiPart = faces.length > 1;
  const lone = !multiPart && figures.length === 1 && figures[0].content_md === undefined;
  const answerLocked = s.returning || phase !== 'answering' || !!s.accepted || !!s.pendingRun;

  const renderSlot = (slot: SlotView) => {
    const spec = nativeSlotFieldSpec(slot);
    if (!spec) return null;
    const entry = s.nativeResponses.entries.find((e) => e.slot_id === slot.slot_id);
    return (
      <ResponseSlotField
        key={slot.slot_id}
        spec={spec}
        value={nativeResponseValue(entry)}
        label={slot.placement?.label}
        notation={notation}
        disabled={answerLocked}
        onChange={(value) => s.updateNativeResponse(nativeResponseEntry(slot, value, entry))}
        feedback={phase === 'feedback' ? 'graded' : 'none'}
        hotkeys={frozen?.response_spec.slots.length === 1 && s.isChoice && phase === 'answering'}
        ariaLabel={slot.placement?.label ?? '作答'}
      />
    );
  };

  const renderMaterial = (m: MaterialView) => {
    const label = m.alt_text ?? m.caption ?? '题目配图';
    const zoomable = m.content_md === undefined && (m.kind === 'figure' || m.kind === 'table');
    return (
      <figure key={m.material_id} className="un-pn-figure">
        {m.content_md !== undefined ? (
          <MathMarkdown notation={notation} className="un-pn-prose">
            {m.content_md}
          </MathMarkdown>
        ) : zoomable ? (
          <button
            type="button"
            className="un-pn-figure-zoom"
            onClick={() => setZoomed(m)}
            aria-label={`放大看：${label}`}
          >
            <AssetEvidencePreview assetId={m.asset_id} kind="image" label={label} />
            <span className="un-pn-figure-hint" aria-hidden="true">
              点开放大
            </span>
          </button>
        ) : (
          <AssetEvidencePreview assetId={m.asset_id} label={label} />
        )}
        {m.caption && <figcaption>{m.caption}</figcaption>}
      </figure>
    );
  };

  const header = (
    <div className="un-pn-companion-head">
      <span className="un-pn-companion-name">学习伙伴</span>
      <span className="un-pn-companion-state">
        {companion === 'embedded' && companionBusy ? '在想…' : '在这里'}
      </span>
    </div>
  );
  // C1 asks for "正在看：…". The companion can't see the question yet (backend gap), so it says so
  // instead of pretending.
  const blindNote = (
    <p className="un-pn-companion-empty">
      它现在还看不到这道题的内容。想问这道题，把题目要点或你卡住的地方写进问题里。
    </p>
  );
  const companionBody = (where: 'panel' | 'sheet') => {
    if (companion !== 'embedded') {
      return (
        <div className="un-pn-companion-body">
          <p className="un-pn-companion-empty">
            这道题还没有和学习伙伴的对话。对话会在下一版接入；现在问的话，它还看不到这道题的内容。
          </p>
          <div className="un-pn-composer" aria-disabled="true">
            <textarea
              rows={2}
              disabled
              placeholder="问点什么（下一版接入）"
              aria-label="问学习伙伴"
            />
          </div>
        </div>
      );
    }
    if ((where === 'sheet') !== isPhone) return null;
    return (
      <div className="un-pn-dock" data-snap={where === 'sheet' ? sheet : undefined}>
        <CopilotDock
          variant="embedded"
          pathname={window.location.pathname}
          navigate={navigate}
          onRevealRequest={() => setSheet((snap) => (snap === 'full' ? snap : 'half'))}
          onBusyChange={setCompanionBusy}
          emptyHint={blindNote}
        />
      </div>
    );
  };

  const banner = (
    <header className="un-pn-banner">
      <Button variant="quiet" size="sm" disabled={s.returning} onClick={() => void s.handleBack()}>
        ← 返回练习
      </Button>
      <p className="un-pn-eyebrow">
        {practiceSourceLabel(item.source)} · 第 {pos} / {total} 题
        {item.estimated_minutes ? ` · 约 ${item.estimated_minutes} 分钟` : ''}
      </p>
      <h1 className="un-pn-title">{title}</h1>
      <div className="un-pn-chips">
        {q?.labels
          .filter((l) => l.name !== title)
          .map((l) => (
            <Chip key={l.id}>{l.name}</Chip>
          ))}
        {s.accepted || s.autoCommitted ? (
          <Chip tone="accent">已提交</Chip>
        ) : lastAttempt ? (
          <Chip tone={HISTORY_TEXT[lastAttempt.outcome].tone}>
            上次 · {HISTORY_TEXT[lastAttempt.outcome].label}
          </Chip>
        ) : q ? (
          <Chip>第一次做</Chip>
        ) : null}
      </div>
    </header>
  );

  // ── Body states (M14): loading skeleton in the page's own shape, error with retry, content.
  let body: React.ReactNode;
  if (s.qQ.isError) {
    body = (
      <div className="un-pn-state" role="alert">
        <p>这道题没取到。可能是网络断了一下。</p>
        <div className="un-pn-actions">
          <Button variant="secondary" onClick={() => void s.qQ.refetch()}>
            再试一次
          </Button>
          <Button variant="quiet" onClick={onBack}>
            返回练习
          </Button>
        </div>
      </div>
    );
  } else if (loading) {
    body = (
      <div className="un-pn-skeleton" role="status" aria-busy="true" aria-label="正在取题">
        <span className="un-pn-skel-h" />
        <span />
        <span />
        <span className="un-pn-skel-short" />
        <span className="un-pn-skel-h un-pn-skel-gap" />
        <span className="un-pn-skel-box" />
      </div>
    );
  } else if (issuanceFailed || !frozen) {
    const problem = issuanceProblem(s.frozenQ.error);
    body = (
      <div className="un-pn-state" role="alert">
        <p>{problem.text}</p>
        <div className="un-pn-actions">
          {problem.selfRate && (
            <Button variant="primary" onClick={() => s.setIssuanceMode('manual')}>
              照常作答，自己评
            </Button>
          )}
          {problem.retry && (
            <Button variant="secondary" onClick={() => void s.frozenQ.refetch()}>
              再试一次
            </Button>
          )}
          <Button variant="quiet" onClick={onBack}>
            返回练习
          </Button>
        </div>
      </div>
    );
  } else {
    const slotsOf = (partId: string) =>
      frozen.response_spec.slots.filter((slot) => slot.part_id === partId);
    const faceParts = new Set(faces.map((f) => f.part_id));
    const looseSlots = frozen.response_spec.slots.filter((slot) => !faceParts.has(slot.part_id));

    const questionSection = (
      <section className="un-pn-section" aria-labelledby="un-pn-question">
        <h2 id="un-pn-question" className="un-pn-h2">
          题目
        </h2>
        <div className={lone ? 'un-pn-stem un-pn-stem-with-figure' : 'un-pn-stem'}>
          {!multiPart && (
            <div className="un-pn-faces">
              {faces.map((face) => (
                <div key={face.part_id} className="un-pn-face">
                  {face.question_no && <span className="un-pn-face-no">{face.question_no}</span>}
                  <MathMarkdown notation={notation} className="un-pn-prose">
                    {face.prompt_md}
                  </MathMarkdown>
                </div>
              ))}
            </div>
          )}
          {figures.length > 0 && <div className="un-pn-figures">{figures.map(renderMaterial)}</div>}
        </div>
      </section>
    );

    const extras = (
      <>
        <EvidenceComposer
          text=""
          onTextChange={() => {}}
          showText={false}
          attachments={s.evidence}
          onAttachmentsChange={s.setEvidence}
          disabled={answerLocked}
          onUploadingChange={s.setUploading}
        />
        {phase === 'answering' && !s.pendingRun && shouldOfferProcessBox(s.isChoice) && (
          <div className="un-pn-trace">
            <button
              type="button"
              className="un-pn-link un-hit"
              aria-expanded={s.showTrace}
              aria-controls="un-pn-trace"
              onClick={() => s.setShowTrace(!s.showTrace)}
            >
              {s.showTrace ? '收起思路' : '＋ 记下你的思路（可选，不计分）'}
            </button>
            <Expand open={s.showTrace} id="un-pn-trace">
              <textarea
                className="un-pn-textarea"
                rows={3}
                value={s.reasoningTrace}
                maxLength={REASONING_TRACE_MAX_LEN}
                placeholder="随手记下你是怎么想的，也可以留空。"
                onChange={(e) => s.setReasoningTrace(e.target.value)}
                aria-label="解题思路（可选）"
              />
            </Expand>
          </div>
        )}
      </>
    );

    const submitRow =
      phase === 'answering' && !s.pendingRun ? (
        <div className="un-pn-actions">
          {s.issuanceMode === 'manual' ? (
            <>
              <span className="un-pn-actions-label">做完了？自己评一下：</span>
              {RATINGS.map((grade) => (
                <Button
                  key={grade}
                  variant="secondary"
                  disabled={!s.canSubmit || s.committing}
                  onClick={() => void s.commit({ withAppeal: false, rating: grade })}
                >
                  {RATING_LABEL[grade]}
                </Button>
              ))}
            </>
          ) : (
            <>
              <Button variant="primary" disabled={!s.canSubmit} onClick={() => void s.runJudge()}>
                {s.judging ? '正在判…' : '提交'}
              </Button>
              <span className="un-pn-hint">
                {s.isChoice ? '数字键选择 · ⌘Enter 提交' : '⌘Enter 提交'}
              </span>
            </>
          )}
        </div>
      ) : null;

    const answerSection = multiPart ? (
      <section className="un-pn-section" aria-labelledby="un-pn-parts">
        <div className="un-pn-section-head">
          <h2 id="un-pn-parts" className="un-pn-h2">
            小问与作答
          </h2>
          <SaveStateChip state={s.autosave.state} onRetry={s.autosave.retry} />
        </div>
        <ol className="un-pn-parts">
          {faces.map((face, index) => (
            <li key={face.part_id} className="un-pn-part">
              <div className="un-pn-face">
                <span className="un-pn-face-no">{face.question_no ?? `(${index + 1})`}</span>
                <MathMarkdown notation={notation} className="un-pn-prose">
                  {face.prompt_md}
                </MathMarkdown>
              </div>
              {slotsOf(face.part_id).length > 0 && (
                <div className="un-pn-answer">{slotsOf(face.part_id).map(renderSlot)}</div>
              )}
            </li>
          ))}
        </ol>
        <div className="un-pn-answer">
          {looseSlots.map(renderSlot)}
          {extras}
        </div>
        {submitRow}
      </section>
    ) : (
      <section className="un-pn-section" aria-labelledby="un-pn-answer">
        <div className="un-pn-section-head">
          <h2 id="un-pn-answer" className="un-pn-h2">
            我的作答
          </h2>
          <SaveStateChip state={s.autosave.state} onRetry={s.autosave.retry} />
        </div>
        <div className="un-pn-answer">
          {frozen.response_spec.slots.map(renderSlot)}
          {extras}
        </div>
        {submitRow}
      </section>
    );

    const verdict = displayedPreview ? verdictWords(displayedPreview) : null;
    const resultSection =
      s.pendingRun || phase !== 'answering' ? (
        <section className="un-pn-section" aria-labelledby="un-pn-result" aria-live="polite">
          <h2 id="un-pn-result" className="un-pn-h2">
            结果
          </h2>
          {s.pendingRun ? (
            <div className="un-pn-result">
              <Chip>判分在后台</Chip>
              <p className="un-pn-result-text">
                {s.pendingPoll.status === 'failed' || s.pendingPoll.error
                  ? '判分暂时没跑成。你的作答已经存住，系统会自动补判，不需要重交。'
                  : '这份作答在排队判分，不需要重交。可以先做下一题，结果稍后到。'}
              </p>
              <div className="un-pn-actions">
                <Button variant="secondary" onClick={onDone}>
                  先做下一题
                </Button>
              </div>
            </div>
          ) : phase === 'confidence' ? (
            <div className="un-pn-result">
              <p className="un-pn-result-text">看结果之前，你有几分把握？</p>
              {/* biome-ignore lint/a11y/useSemanticElements: a row of pill buttons, not a form field set (same pattern as PfSolo's confidence row). */}
              <div className="un-pn-scale" role="group" aria-label="把握程度，1 到 5">
                {[1, 2, 3, 4, 5].map((n) => (
                  <Button
                    key={n}
                    variant="secondary"
                    size="sm"
                    aria-label={`把握 ${n} 分（共 5 分）`}
                    onClick={() => s.revealVerdict(n)}
                  >
                    {n}
                  </Button>
                ))}
                <Button variant="quiet" size="sm" onClick={() => s.revealVerdict(null)}>
                  跳过
                </Button>
              </div>
              <p className="un-pn-hint">1 = 全靠猜 · 5 = 十拿九稳 · 不计分</p>
            </div>
          ) : displayedPreview && verdict ? (
            <div className="un-pn-result" data-tone={verdict.tone}>
              <div className="un-pn-verdict">
                <Chip tone={verdict.tone}>{verdict.label}</Chip>
                {verdict.note && <span className="un-pn-hint">{verdict.note}</span>}
              </div>
              {displayedPreview.coarse_outcome === 'unsupported' ? (
                <p className="un-pn-result-text">
                  {s.autoCommitted || s.committedPreview
                    ? '这题暂时没法自动判，这次作答已经存下了。可以继续下一题，或者返回练习跳过它。'
                    : '这题暂时没法自动判。可以先自己评一下，或者返回练习跳过这题。'}
                </p>
              ) : displayedPreview.feedback_md ? (
                <MathMarkdown notation={notation} className="un-pn-prose un-pn-result-text">
                  {displayedPreview.feedback_md}
                </MathMarkdown>
              ) : null}
              {q?.reference_md && (
                <div className="un-pn-reference">
                  <span className="un-pn-hint">参考答案</span>
                  <MathMarkdown notation={notation} className="un-pn-prose">
                    {q.reference_md}
                  </MathMarkdown>
                </div>
              )}

              {!s.autoCommitted && (
                <div className="un-pn-rate">
                  <span className="un-pn-actions-label">按这次的情况安排复习：</span>
                  {RATINGS.map((g) => (
                    <ChipToggle
                      key={g}
                      pressed={s.rating === g}
                      onPressedChange={() => s.setRating(g)}
                    >
                      {RATING_LABEL[g]}
                    </ChipToggle>
                  ))}
                  <span className="un-pn-hint">
                    {displayedPreview.suggested_rating
                      ? `建议：${RATING_LABEL[displayedPreview.suggested_rating]}`
                      : '这次没有建议，自己选一个'}
                  </span>
                </div>
              )}

              <div className="un-pn-actions">
                {displayedPreview.coarse_outcome === 'unsupported' &&
                  !s.autoCommitted &&
                  !s.committedPreview && (
                    <Button variant="secondary" onClick={s.startSelfRate}>
                      自己评一下
                    </Button>
                  )}
                {s.autoCommitted ? (
                  <Button variant="primary" disabled={s.committing} onClick={onDone}>
                    下一题
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    disabled={s.committing || !s.rating}
                    onClick={() =>
                      s.rating && void s.commit({ withAppeal: false, rating: s.rating })
                    }
                  >
                    {s.committing ? '正在记下…' : '确认，下一题'}
                  </Button>
                )}
                {appealEntryAvailable({
                  phase,
                  appealOpen: s.appealOpen,
                  autoCommitted: s.autoCommitted,
                  autoCommitJudgeEventId: s.autoCommitJudgeEventId,
                }) && (
                  <button
                    type="button"
                    className="un-pn-link un-hit"
                    aria-expanded={false}
                    aria-controls="un-pn-appeal"
                    onClick={() => s.setAppealOpen(true)}
                  >
                    觉得判得不对？说明理由重判
                  </button>
                )}
              </div>

              <Expand open={s.appealOpen} id="un-pn-appeal">
                <div className="un-pn-appeal">
                  <textarea
                    className="un-pn-textarea"
                    rows={2}
                    value={s.appealText}
                    placeholder="说说为什么，比如「我的写法和参考答案是等价的」"
                    onChange={(e) => s.setAppealText(e.target.value)}
                    aria-label="重判理由"
                  />
                  <div className="un-pn-actions">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={
                        !s.appealText.trim() ||
                        s.committing ||
                        (s.autoCommitted ? !s.autoCommitJudgeEventId : !s.rating)
                      }
                      onClick={() => {
                        if (s.autoCommitted) void s.submitAutoCommitAppeal();
                        else if (s.rating) void s.commit({ withAppeal: true, rating: s.rating });
                      }}
                    >
                      提交重判，先继续
                    </Button>
                    <Button variant="quiet" size="sm" onClick={() => s.setAppealOpen(false)}>
                      算了
                    </Button>
                    <span className="un-pn-hint">重判在后台进行，不耽误做下一题</span>
                  </div>
                </div>
              </Expand>
            </div>
          ) : null}
        </section>
      ) : null;

    const historySection =
      timeline.length > 0 ? (
        <section className="un-pn-section" aria-labelledby="un-pn-history">
          <h2 id="un-pn-history" className="un-pn-h2">
            作答记录
          </h2>
          <ol className="un-pn-history">
            {[...timeline].reverse().map((e) => (
              <li key={e.event_id}>
                <span className="un-pn-history-day">{formatDay(e.created_at_sec)}</span>
                {e.kind === 'attempt' ? (
                  <>
                    <Chip tone={HISTORY_TEXT[e.outcome].tone}>{HISTORY_TEXT[e.outcome].label}</Chip>
                    {e.cause?.primary_label && (
                      <span className="un-pn-history-cause">{e.cause.primary_label}</span>
                    )}
                  </>
                ) : (
                  <span className="un-pn-history-cause">复习 · 按间隔安排</span>
                )}
              </li>
            ))}
          </ol>
        </section>
      ) : null;

    const questionColumn = (
      <>
        {(!hasPassage || figures.length > 0 || !multiPart) && questionSection}
        {answerSection}
        {resultSection}
        {historySection}
      </>
    );

    body = hasPassage ? (
      // R9: the passage stays pinned on the left and scrolls on its own; questions on the right.
      <div className="un-pn-split" data-pane={pane}>
        <div className="un-pn-pane-switch">
          <Segmented
            label="文章与题目"
            value={pane}
            onChange={setPane}
            options={[
              { value: 'passage', label: '文章' },
              { value: 'questions', label: '题目' },
            ]}
          />
        </div>
        <section className="un-pn-passage" aria-label="文章">
          {passages.map((m) => (
            <div key={m.material_id} className="un-pn-passage-block">
              {m.caption && <p className="un-pn-passage-title">{m.caption}</p>}
              <MathMarkdown notation={notation} className="un-pn-prose">
                {m.content_md ?? ''}
              </MathMarkdown>
            </div>
          ))}
        </section>
        <div className="un-pn-questions">{questionColumn}</div>
      </div>
    ) : (
      questionColumn
    );
  }

  return (
    <UiNextRoot className="un-pn-root">
      <div className="un-pn">
        <div className="un-pn-main">
          <div className={hasPassage ? 'un-pn-column un-pn-column-wide' : 'un-pn-column'}>
            {banner}
            {body}
          </div>
        </div>
        <CompanionPanel open label="学习伙伴" header={header}>
          {companionBody('panel')}
        </CompanionPanel>
      </div>
      <div className="un-pn-phone-sheet">
        <BottomSheet
          label="学习伙伴"
          snap={sheet}
          onSnapChange={setSheet}
          bottomInset={shellInset}
          header={header}
        >
          {companionBody('sheet')}
        </BottomSheet>
      </div>
      <FigureLightbox
        open={zoomed !== null}
        onClose={() => setZoomed(null)}
        assetId={zoomed?.asset_id ?? ''}
        label={zoomed?.alt_text ?? zoomed?.caption ?? '题目配图'}
      />
      <Toaster toasts={toaster.toasts} dismiss={toaster.dismiss} />
    </UiNextRoot>
  );
}
