// YUK-1473 — the single-question practice page, layout 「纸面」 (owner 2026-10-16 18:17:
// 「纸面 默认新不用开关」). It replaced the old PfSolo view: same engine (usePracticeSubmit), so the
// issuance command, drafts, autosave, conflicts, 「返回流」, judging, appeal and the pending poll
// behave exactly as before; only the drawing is new.
//
// Composition (docs/design/2026-10-07-ui-visual-direction.md):
// - banner (R2): way back and 需要提示？ (the hint drawer) on one quiet line, eyebrow (source ·
//   position · minutes), serif title, state chips; the mascot sits at the banner's right in the
//   page's flow (B1; it scrolls with the banner);
// - one sheet of paper: the question with its number in the gutter, each answer written right
//   under its own question on ruled lines, a glass action bar floating at the bottom while
//   answering (T3: a floating layer), then the result settling in place (R3) and the earlier
//   attempts at the end;
// - passage items keep the passage pinned left and the questions right (R9);
// - a question whose issuance carries a presentation (YUK-1497) is drawn by its block tree
//   instead: the blocks lay out the text, figures, passage and inputs, and their answers go
//   through the same draft, autosave and submit engine.
// The companion stays the global Copilot drawer, opened from the shell's Copilot button as in 纸面;
// where it sits on this page is not decided, so it is not embedded here. Quoting question text
// puts it in that drawer's composer.
//
// No effects. Window listeners belong to DOM nodes through ref callbacks (pagehide flush on the
// answering root, ⌘Enter on the action bar, the selection listener on the quotable root); the
// shell's sticky bars are read through useSyncExternalStore.

import { ArrowLeft, Camera, Lightbulb, MessageSquareQuote, PenLine } from 'lucide-react';
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { PracticeIssuanceDtoT } from '@/core/schema/assessment';
import { REASONING_TRACE_MAX_LEN } from '@/kernel/limits';
import { AssetEvidencePreview } from '@/ui/components/response/AssetEvidencePreview';
import { EvidenceComposer } from '@/ui/components/response/EvidenceComposer';
import { ResponseSlotField, nativeSlotFieldSpec } from '@/ui/components/response/ResponseSlotField';
import { nativeResponseEntry, nativeResponseValue } from '@/ui/components/response/response-types';
import { SaveStateChip } from '@/ui/components/response/SaveStateChip';
import { ApiError } from '@/ui/lib/api';
import { MathMarkdown } from '@/ui/lib/math-markdown';
import { openCopilot } from '@/ui/lib/use-copilot-dwell';
import { CollapsibleList } from '@/ui/primitives/CollapsibleList';
import {
  Button,
  Chip,
  ChipToggle,
  type ChipTone,
  Expand,
  IconButton,
  Judgment,
  type JudgmentPhase,
  Mascot,
  Segmented,
  UiNextRoot,
  flyQuote,
  prefersReducedMotion,
} from '@/ui-next/public';
import type { AttemptTimelineEvent } from '../attempt-timeline-adapter';
import { PresentationBlocks } from '../blocks/PresentationBlocks';
import { practiceMorphKey, practiceSourceLabel } from '../PfStream';
import type { StreamItem } from '../practice-api';
import {
  type JudgeFeedback,
  type PracticeToast,
  type Rating,
  appealEntryAvailable,
  isObjectiveQuestion,
  shouldOfferProcessBox,
  usePracticeSubmit,
} from '../use-practice-submit';
import { DraftConflictPanel } from './DraftConflictPanel';
import { FigureLightbox } from './FigureLightbox';
import { QuoteBubble, clipQuote, useQuotableSelection } from './QuoteSelection';
import { SoloCoach } from './SoloCoach';
import './practice-solo.css';

export interface PracticeSoloProps {
  item: StreamItem;
  /** YUK-535 — server-resolved KC-scoped review session; null for the daily stream. */
  sessionId?: string | null;
  pos: number;
  total: number;
  /** 下一题: the host marks the item done and opens the next one. */
  onDone: () => void;
  onBack: () => void;
  /** YUK-432 — 「返回流」 after an automatic commit: the host marks the item done, then lists. */
  onCommittedBack?: () => void;
  addToast: PracticeToast;
  /**
   * YUK-1473 — the host is moving to the next question in place: this question is finished and
   * stays on screen until the next one is confirmed; every way forward waits, calmly.
   */
  advancing?: boolean;
  /** A result (or the 「already handed in」 line) is on screen: the host may prefetch the next. */
  onResultShown?: (item: StreamItem) => void;
}

type MaterialView = PracticeIssuanceDtoT['materials'][number];
type SlotView = PracticeIssuanceDtoT['response_spec']['slots'][number];

const RATING_LABEL: Record<Rating, string> = { again: '再练', hard: '模糊', good: '掌握' };
const RATINGS: readonly Rating[] = ['again', 'hard', 'good'];

const ATTEMPT_TEXT = {
  success: { label: '做对了', tone: 'positive' },
  failure: { label: '没做对', tone: 'caution' },
  partial: { label: '部分对', tone: 'caution' },
  pending: { label: '还在判', tone: 'neutral' },
  unsupported: { label: '没法自动判', tone: 'neutral' },
} as const satisfies Record<string, { label: string; tone: ChipTone }>;

function formatDay(sec: number): string {
  const d = new Date(sec * 1000);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatDuration(ms: number | null): string | null {
  if (ms == null || ms <= 0) return null;
  if (ms < 60_000) return `用时 ${Math.max(1, Math.round(ms / 1000))} 秒`;
  return `用时 ${Math.round(ms / 60_000)} 分钟`;
}

/** Plain verdict words (R3): a deterministic check says what it compared and nothing more. */
function verdictWords(p: JudgeFeedback): { label: string; tone: ChipTone; note: string | null } {
  if (p.coarse_outcome === 'unsupported') {
    return { label: '暂时没法自动判', tone: 'neutral', note: null };
  }
  // Some parts are known right, but the points are not: never shown as 0 or as "can't judge".
  if (p.coarse_outcome === 'partial_unknown') {
    const counts = (p.partial_units ?? [])
      .map((unit) => `${unit.correct_count}/${unit.total_count}`)
      .join('、');
    return {
      label: `部分正确${counts ? `（${counts}）` : ''}，分数未知`,
      tone: 'caution',
      note: '对了几处是确定的；这道题的分数还算不出来，不按 0 分记。',
    };
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

/** A short fingerprint of a verdict: a new one turns the mascot one petal (B2). */
function verdictKey(p: JudgeFeedback): string {
  const text = `${p.route}|${p.coarse_outcome}|${p.confidence}|${p.feedback_md ?? ''}`;
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
  return `${p.coarse_outcome}:${(hash >>> 0).toString(36)}`;
}

/** Why this question can't be answered here, in learner words; only the typed code is read. */
function issuanceProblem(error: unknown): { text: string; selfRate: boolean } {
  const code = error instanceof ApiError ? error.code : null;
  if (code === 'not_admitted') {
    return {
      text: '这道题还不能自动判分。可以照常作答，做完自己评一下，用来安排复习。',
      selfRate: true,
    };
  }
  if (code === 'suspended' || code === 'withdrawn' || code === 'unpublished') {
    return { text: '这道题暂时停用了，可以再试一次，或者先返回做别的题。', selfRate: false };
  }
  if (!error) return { text: '正在恢复作答，没有读到这道题的内容。', selfRate: false };
  return { text: '这道题暂时没法在这里作答。可以再试一次，或者先返回练习。', selfRate: false };
}

// ── The retained shell's sticky bars (transitional, until the shell itself moves to ui-next):
// the action bar floats above the phone tab bar and the pinned passage sits below the top bar.
// Read through an external store; the ResizeObserver lives only while something subscribes.
function shellBar(selector: string): number {
  const el = document.querySelector<HTMLElement>(selector);
  return el && getComputedStyle(el).display !== 'none' ? el.offsetHeight : 0;
}
function subscribeShellBars(onChange: () => void) {
  const ro = new ResizeObserver(onChange);
  for (const selector of ['.main > .topbar', '.mobile-tabbar']) {
    const el = document.querySelector(selector);
    if (el) ro.observe(el);
  }
  window.addEventListener('resize', onChange);
  return () => {
    ro.disconnect();
    window.removeEventListener('resize', onChange);
  };
}
const readShellBars = () => `${shellBar('.main > .topbar')} ${shellBar('.mobile-tabbar')}`;

/** A question opens at its top (ref callback on the banner, which mounts once per question). */
function startAtTop(node: HTMLElement | null) {
  if (node) window.scrollTo({ top: 0, behavior: 'instant' });
}

/** The Copilot drawer's composer, once it is laid out (the drawer may still be sliding in). */
function copilotComposer(): HTMLElement | null {
  const el = document.querySelector<HTMLElement>('[data-testid="copilot-composer-input"]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? el : null;
}

/** Where a quote button's text sits on the page: the block it belongs to. */
const QUOTE_BLOCK = '.un-ps-sheet-q, .un-ps-vpart, .un-ps-passage-block';

function QuoteButton({
  text,
  what,
  onQuote,
}: {
  text: string;
  what: string;
  onQuote: (text: string, from: DOMRect | null) => void;
}) {
  if (!text.trim()) return null;
  return (
    <IconButton
      label={`把${what}引用到学习伙伴`}
      className="un-ps-quote-btn"
      icon={<MessageSquareQuote size={14} />}
      onClick={(e) =>
        onQuote(text, e.currentTarget.closest(QUOTE_BLOCK)?.getBoundingClientRect() ?? null)
      }
    />
  );
}

/** The earlier attempts at this question, newest first, folded to the newest 3; a cause seen twice
 * across the whole history is marked (YUK-617). */
function AttemptHistory({
  events,
  headingId,
}: {
  events: AttemptTimelineEvent[];
  headingId: string;
}) {
  if (events.length === 0) return null;
  const causeCounts = new Map<string, number>();
  for (const e of events) {
    if (e.kind === 'attempt' && e.cause) {
      causeCounts.set(e.cause.primary, (causeCounts.get(e.cause.primary) ?? 0) + 1);
    }
  }
  return (
    <section className="un-ps-section un-ps-history-section" aria-labelledby={headingId}>
      <h2 id={headingId} className="un-ps-h2">
        作答记录
      </h2>
      {/* Newest 3 show; the rest fold behind 「全部 N 条」 (owner 2026-10-18, design doc L5). */}
      <CollapsibleList
        items={events}
        className="un-ps-history"
        toggleClassName="un-ps-history-toggle"
        renderItem={(e) => {
          const duration = formatDuration(e.duration_ms);
          if (e.kind === 'review') {
            return (
              <li key={e.event_id} data-tone="neutral">
                <span className="un-ps-history-dot" aria-hidden="true" />
                <span className="un-ps-history-day">{formatDay(e.created_at_sec)}</span>
                <span className="un-ps-history-cause">
                  复习 · 自评「{RATING_LABEL[e.fsrs_rating]}」
                </span>
                {duration && <span className="un-ps-history-day">{duration}</span>}
              </li>
            );
          }
          const text = ATTEMPT_TEXT[e.outcome];
          const repeated = !!e.cause && (causeCounts.get(e.cause.primary) ?? 0) >= 2;
          return (
            <li key={e.event_id} data-tone={text.tone}>
              <span className="un-ps-history-dot" aria-hidden="true" />
              <span className="un-ps-history-day">{formatDay(e.created_at_sec)}</span>
              <span className="un-ps-history-outcome">{text.label}</span>
              {e.cause && (
                <span className="un-ps-history-cause" data-repeated={repeated || undefined}>
                  {repeated ? '又是：' : ''}
                  {e.cause.primary_label ?? e.cause.primary}
                </span>
              )}
              {duration && <span className="un-ps-history-day">{duration}</span>}
            </li>
          );
        }}
      />
    </section>
  );
}

export function PracticeSolo({
  item,
  sessionId,
  pos,
  total,
  onDone,
  onBack,
  onCommittedBack,
  addToast,
  advancing = false,
  onResultShown,
}: PracticeSoloProps) {
  const [coachOpen, setCoachOpen] = useState(false);
  // How many times the hint drawer has been opened; each opening starts a fresh ladder (YUK-1483).
  const [coachSession, setCoachSession] = useState(0);
  const openCoach = () => {
    setCoachOpen(true);
    setCoachSession((n) => n + 1);
  };
  // YUK-562 — 「写思路」 starts folded.
  const [showTrace, setShowTrace] = useState(false);
  const [zoomed, setZoomed] = useState<MaterialView | null>(null);
  // While a layer covers the page (hint drawer, figure zoom), ⌘Enter and the number keys pause.
  const hotkeysSuspended = coachOpen || zoomed !== null;
  const [pane, setPane] = useState<'passage' | 'questions'>('questions');
  const quoteSel = useQuotableSelection();
  const [shellTop, shellBottom] = useSyncExternalStore(
    subscribeShellBars,
    readShellBars,
    () => '0 0',
  )
    .split(' ')
    .map(Number);
  const uid = useId();
  const id = (name: string) => `${uid}-${name}`;

  // ── Quote into the Copilot drawer (M6): the passage lifts off the page and lands in the
  // composer, tracking it while the drawer opens. The page root owns the flight: its ref
  // callback's cleanup cancels one still in the air when the question goes away.
  const pageRoot = useRef<HTMLElement | null>(null);
  const flight = useRef<(() => void) | null>(null);
  const attachPage = useCallback((node: HTMLElement | null) => {
    if (!node) return undefined;
    pageRoot.current = node;
    return () => {
      flight.current?.();
      flight.current = null;
      pageRoot.current = null;
    };
  }, []);
  const quoteToCopilot = (text: string, from: DOMRect | null) => {
    const clipped = clipQuote(text);
    if (!clipped) return;
    // M3: a new quote takes over; the one in the air fades where it is.
    flight.current?.();
    flight.current = null;
    openCopilot(`「${clipped}」\n`, { send: false });
    const scope = pageRoot.current?.closest('[data-ui-next]');
    // Reduced motion: the quote is simply in the composer.
    if (!scope || !from || prefersReducedMotion()) return;
    // The drawer opens on the next render; launch once it has a frame to be measured in.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        frame = 0;
        flight.current = flyQuote({
          from,
          content: clipped,
          to: copilotComposer,
          scope,
          onLand: () => {
            flight.current = null;
          },
        });
      });
    });
    flight.current = () => cancelAnimationFrame(frame);
  };

  // M13 — once a result is on screen, the host may read the next question ahead (a GET only).
  // The result section's ref callback says so when it attaches; the host keeps it to once.
  const reportResult = useCallback(
    (node: HTMLElement | null) => {
      if (node) onResultShown?.(item);
    },
    [onResultShown, item],
  );

  const { question, issuance, draft, conflict, submit, appeal, handleBack, ...refs } =
    usePracticeSubmit({
      item,
      sessionId,
      onDone,
      onBack,
      onCommittedBack,
      addToast,
      hotkeysSuspended,
    });
  const q = question.data;
  const notation = q?.notation ?? null;
  const ready = issuance.status === 'ready' ? issuance : null;
  const frozen = ready?.frozen ?? null;
  const { phase, displayedPreview } = submit;

  // ── Banner: what this question is and where it stands.
  const title = item.knowledge_name ?? q?.labels[0]?.name ?? '这道题';
  const lastAttempt = question.timelineEvents.find((e) => e.kind === 'attempt');
  let state: { label: string; tone?: ChipTone } | null = null;
  if (ready?.accepted || submit.autoCommitted) state = { label: '已提交', tone: 'accent' };
  else if (lastAttempt?.kind === 'attempt') {
    const h = ATTEMPT_TEXT[lastAttempt.outcome];
    state = { label: `上次 · ${h.label}`, tone: h.tone };
  } else if (q) state = { label: '第一次做' };
  const labels = (q?.labels ?? []).filter((l) => l.name !== title);

  // 纸面's banner: the text column (the way back, eyebrow, title, chips) with the mascot at its
  // right. 纸面 has no hint entry; 需要提示？ sits beside 返回练习 in the same quiet style, so the
  // banner keeps 纸面's height. The companion opens from the shell's Copilot button, as in 纸面.
  const banner = (
    <header className="un-ps-banner" ref={startAtTop}>
      <div className="un-ps-banner-text">
        <div className="un-ps-back-row">
          {/* YUK-432 — after an automatic commit 「返回」 marks the item done (handleBack). Never
              blocked by the draft: at most 8s for the last save, then an honest toast (YUK-1489). */}
          <Button
            variant="quiet"
            size="sm"
            disabled={submit.returning}
            // While the host moves on in place, this question is finished (its answer is recorded
            // and its draft settles on unmount): back just leaves and cancels the move.
            onClick={() => (advancing ? onBack() : void handleBack())}
          >
            <ArrowLeft size={14} aria-hidden="true" />
            {submit.returning ? '正在保存…' : '返回练习'}
          </Button>
          {!question.isInterventionDiagnostic && (
            <Button variant="quiet" size="sm" onClick={openCoach}>
              <Lightbulb size={14} aria-hidden="true" />
              需要提示？
            </Button>
          )}
        </div>
        <p className="un-ps-eyebrow">
          {practiceSourceLabel(item.source)} · 第 <span className="un-num">{pos}</span> / {total} 题
          {item.estimated_minutes ? ` · 约 ${item.estimated_minutes} 分钟` : ''}
        </p>
        {/* M4: the shared title. It grows out of the stream row, folds back into it, and
            morphs into the next question's title when the page moves on in place. */}
        <h1 className="un-ps-title" data-morph={practiceMorphKey(item.id)} tabIndex={-1}>
          {title}
        </h1>
        {(labels.length > 0 || state) && (
          <div className="un-ps-chips">
            {labels.map((l) => (
              <Chip key={l.id}>{l.name}</Chip>
            ))}
            {state && <Chip tone={state.tone}>{state.label}</Chip>}
          </div>
        )}
      </div>
      {/* B1/B2: the mascot spins while 「正在判…」 shows and turns a petal when a result lands. */}
      <Mascot
        thinking={phase === 'answering' && submit.judging && !submit.pendingRun}
        settleKey={displayedPreview ? verdictKey(displayedPreview) : null}
      />
    </header>
  );

  const skeleton = (
    label: string,
    attach?: (node: HTMLElement | null) => (() => void) | undefined,
  ) => (
    <div className="un-ps-skeleton" role="status" aria-busy="true" aria-label={label} ref={attach}>
      <span className="un-ps-skel-h" />
      <span />
      <span />
      <span className="un-ps-skel-short" />
      <span className="un-ps-skel-box" />
    </div>
  );

  // ── Body states (M14): loading in the page's own shape, error with a way on, content.
  let body: ReactNode;
  if (question.query.isError) {
    body = (
      <div className="un-ps-state" role="alert">
        <p>这道题没取到，可能是网络断了一下。</p>
        <div className="un-ps-actions">
          <Button variant="secondary" onClick={() => void question.query.refetch()}>
            再试一次
          </Button>
          <Button variant="quiet" onClick={onBack}>
            返回练习
          </Button>
        </div>
      </div>
    );
  } else if (!q) {
    body = skeleton('正在取题');
  } else if (issuance.status === 'pending') {
    // YUK-1484 — the issuance command runs when this placeholder attaches. It is deliberately not
    // on the error view below, so a failed request never retries itself by re-attaching.
    body = skeleton('正在取题', issuance.attach);
  } else if (issuance.status === 'failed') {
    const problem = issuanceProblem(issuance.error);
    body = (
      <div className="un-ps-state" role="alert">
        <p>{problem.text}</p>
        <div className="un-ps-actions">
          {problem.selfRate ? (
            <Button variant="primary" onClick={issuance.startSelfRated}>
              按自行评级练习
            </Button>
          ) : (
            <Button variant="secondary" onClick={issuance.retry}>
              重试
            </Button>
          )}
          <Button variant="quiet" onClick={onBack}>
            返回练习
          </Button>
        </div>
      </div>
    );
  } else if (!issuance.restored || !frozen) {
    body = skeleton('正在恢复作答');
  } else {
    body = (
      <div className="un-ps-body" ref={refs.attachPagehideFlush}>
        <div className="un-ps-quotable" ref={quoteSel.attach}>
          {renderSheet()}
        </div>
      </div>
    );
  }

  // The sheet, drawn by a plain function over this render (not a component, so it never remounts).
  function renderSheet(): ReactNode {
    if (!frozen || !ready || !q) return null;
    const passages = frozen.materials.filter(
      (m) => m.kind === 'passage' && m.content_md !== undefined,
    );
    const figures = frozen.materials.filter((m) => !passages.includes(m));
    const hasPassage = passages.length > 0;
    const faces = frozen.faces;
    const multiPart = faces.length > 1;
    const lone = !multiPart && figures.length === 1 && figures[0].content_md === undefined;
    // YUK-1501 — an answer already recorded is read-only review: no action bar, so no 提交,
    // self-rating or ⌘Enter; a plain line says why instead.
    const answering = phase === 'answering' && !submit.pendingRun && !submit.answerRecorded;
    const answerLocked =
      submit.returning ||
      phase !== 'answering' ||
      !!ready.accepted ||
      !!submit.pendingRun ||
      !!conflict;
    const offerTrace = answering && shouldOfferProcessBox(draft.isChoice);
    const slotsOf = (partId: string) =>
      frozen.response_spec.slots.filter((slot) => slot.part_id === partId);
    const faceParts = new Set(faces.map((f) => f.part_id));
    const looseSlots = frozen.response_spec.slots.filter((slot) => !faceParts.has(slot.part_id));

    const renderSlot = (slot: SlotView) => {
      const spec = nativeSlotFieldSpec(slot);
      if (!spec) return null;
      const entry = draft.responses.entries.find((e) => e.slot_id === slot.slot_id);
      return (
        <ResponseSlotField
          key={slot.slot_id}
          spec={spec}
          value={nativeResponseValue(entry)}
          label={slot.placement?.label}
          notation={notation}
          disabled={answerLocked}
          onChange={(value) => draft.updateResponse(nativeResponseEntry(slot, value, entry))}
          feedback={phase === 'feedback' ? 'graded' : 'none'}
          hotkeys={
            frozen.response_spec.slots.length === 1 &&
            draft.isChoice &&
            phase === 'answering' &&
            !hotkeysSuspended
          }
          ariaLabel={slot.placement?.label ?? '作答'}
        />
      );
    };

    const renderMaterial = (m: MaterialView) => {
      const label = m.alt_text ?? m.caption ?? '题目配图';
      const zoomable = m.content_md === undefined && (m.kind === 'figure' || m.kind === 'table');
      return (
        <figure key={m.material_id} className="un-ps-figure">
          {m.content_md !== undefined ? (
            <MathMarkdown notation={notation} className="un-ps-prose">
              {m.content_md}
            </MathMarkdown>
          ) : zoomable ? (
            <button
              type="button"
              className="un-ps-figure-zoom"
              onClick={() => setZoomed(m)}
              aria-label={`放大看：${label}`}
            >
              <AssetEvidencePreview assetId={m.asset_id} kind="image" label={label} />
              <span className="un-ps-figure-hint" aria-hidden="true">
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

    const figuresEl =
      figures.length > 0 ? (
        <div className="un-ps-figures">{figures.map(renderMaterial)}</div>
      ) : null;
    const stemText = faces.map((f) => f.prompt_md).join('\n');
    const stemBlock = (
      <div className="un-ps-stem" data-lone={lone || undefined}>
        {lone && figuresEl}
        {!multiPart && (
          <div className="un-ps-faces" data-quotable="">
            {faces.map((face) => (
              <div key={face.part_id} className="un-ps-face">
                {face.question_no && <span className="un-ps-face-no">{face.question_no}</span>}
                <MathMarkdown notation={notation} className="un-ps-prose">
                  {face.prompt_md}
                </MathMarkdown>
              </div>
            ))}
          </div>
        )}
        {!lone && figuresEl}
      </div>
    );

    // Worksheet numbering (owner 2026-10-11 16:44): a filled coral square for the question, a
    // thin coral ring for each part, with the same numbers as the question text.
    const partList = (
      <ol className="un-ps-vparts">
        {faces.map((face, index) => {
          const no = face.question_no ?? `(${index + 1})`;
          const slots = slotsOf(face.part_id);
          return (
            <li key={face.part_id} className="un-ps-vpart">
              <span className="un-ps-ring un-num" role="img" aria-label={`第 ${no} 问`}>
                {no.replace(/[()（）\s]/g, '')}
              </span>
              <div className="un-ps-vpart-body">
                <div className="un-ps-vpart-prompt" data-quotable="">
                  <MathMarkdown notation={notation} className="un-ps-prose">
                    {face.prompt_md}
                  </MathMarkdown>
                </div>
                {slots.length > 0 && <div className="un-ps-write">{slots.map(renderSlot)}</div>}
              </div>
              <div className="un-ps-vpart-side">
                <QuoteButton
                  text={`${no} ${face.prompt_md}`}
                  what={`第 ${no} 问`}
                  onQuote={quoteToCopilot}
                />
              </div>
            </li>
          );
        })}
      </ol>
    );
    const answerFields = multiPart ? (
      <>
        {partList}
        {looseSlots.length > 0 && <div className="un-ps-write">{looseSlots.map(renderSlot)}</div>}
      </>
    ) : (
      <div className="un-ps-write">{frozen.response_spec.slots.map(renderSlot)}</div>
    );

    // Attachments and the thinking field have nothing to show once the answer is locked and empty.
    const extrasVisible = !answerLocked || draft.evidence.length > 0 || (offerTrace && showTrace);
    const extras = extrasVisible ? (
      <div className="un-ps-extras">
        <EvidenceComposer
          text=""
          onTextChange={() => {}}
          showText={false}
          attachments={draft.evidence}
          onAttachmentsChange={draft.updateEvidence}
          disabled={answerLocked}
          onUploadingChange={draft.setUploading}
          inputId={id('attach')}
          showAddButton={false}
        />
        {offerTrace && (
          // YUK-562 — optional, not scored, never blocks submit; empty is not sent.
          <Expand open={showTrace} id={id('trace')}>
            <textarea
              className="un-ps-textarea"
              rows={2}
              value={submit.reasoningTrace}
              maxLength={REASONING_TRACE_MAX_LEN}
              placeholder="随手记下你是怎么想的，不评分，也可以留空。"
              onChange={(e) => submit.setReasoningTrace(e.target.value)}
              aria-label="解题思路（可选）"
            />
          </Expand>
        )}
      </div>
    ) : null;

    // While answering: 提交 (or the self-rating), then 拍照/附件 and 写思路. The bar owns the
    // ⌘/Ctrl+Enter hotkey: it exists only while answering. As in 纸面, the shortcut is named in the
    // submit button's title, not in a hint line on the bar.
    const actionBar = answering ? (
      // biome-ignore lint/a11y/useSemanticElements: a toolbar of buttons, not a form field set.
      <div
        className="un-ps-bar un-glass"
        role="group"
        aria-label="作答操作"
        ref={refs.attachSubmitHotkey}
      >
        <div className="un-ps-bar-main">
          {ready.mode === 'manual' ? (
            <>
              <span className="un-ps-actions-label">做完了？自己评一下：</span>
              {RATINGS.map((grade) => (
                <Button
                  key={grade}
                  variant="secondary"
                  size="sm"
                  disabled={!submit.canSubmit || submit.committing || advancing}
                  onClick={() => void submit.commit({ withAppeal: false, rating: grade })}
                >
                  {RATING_LABEL[grade]}
                </Button>
              ))}
            </>
          ) : (
            <Button
              variant="primary"
              className="un-ps-submit"
              disabled={!submit.canSubmit}
              title="⌘Enter 也能提交"
              aria-keyshortcuts="Meta+Enter Control+Enter"
              onClick={() => void submit.runJudge()}
            >
              {submit.judging ? '正在判…' : '提交'}
            </Button>
          )}
          {submit.customSummary.length > 0 && (
            <span className="un-ps-hint un-ps-custom-answer">
              你的作答：{submit.customSummary.join('；')}
            </span>
          )}
        </div>
        <div className="un-ps-bar-tools">
          <Button
            variant="quiet"
            size="sm"
            disabled={answerLocked || draft.uploading}
            onClick={() => document.getElementById(id('attach'))?.click()}
          >
            <Camera size={15} aria-hidden="true" />
            {draft.uploading ? '上传中…' : '拍照/附件'}
          </Button>
          {offerTrace && (
            <Button
              variant="quiet"
              size="sm"
              aria-expanded={showTrace}
              aria-controls={id('trace')}
              data-on={showTrace || undefined}
              onClick={() => setShowTrace(!showTrace)}
            >
              <PenLine size={15} aria-hidden="true" />
              {showTrace ? '收起思路' : '写思路'}
            </Button>
          )}
        </div>
        <span className="un-ps-bar-save">
          {!conflict && (
            <SaveStateChip state={draft.autosave.state} onRetry={draft.autosave.retry} />
          )}
        </span>
      </div>
    ) : null;

    // Submit → judgment (R3): one element goes from 「正在判」 to the result in place, and the
    // explanation opens beneath it. Open questions stop in between for the confidence beat.
    const verdict = displayedPreview ? verdictWords(displayedPreview) : null;
    const unknownScore = displayedPreview?.coarse_outcome === 'partial_unknown';
    let judgmentPhase: JudgmentPhase | null = null;
    if (phase === 'feedback' && displayedPreview) judgmentPhase = 'settled';
    else if (phase === 'answering' && submit.judging && !submit.pendingRun)
      judgmentPhase = 'checking';

    let result: ReactNode = null;
    if (submit.answerRecorded && phase === 'answering' && !submit.pendingRun) {
      result = (
        <div className="un-ps-result">
          <p className="un-ps-result-text">
            这道题已经交过了，这里只能查看当时交的作答，不能再交一次。结果在下面的作答记录里。
          </p>
        </div>
      );
    } else if (submit.pendingRun) {
      // YUK-1051 — 202-pending: the answer is stored; the same run is polled, never resubmitted.
      result = (
        <div className="un-ps-result">
          <Chip>判分在后台</Chip>
          <p className="un-ps-result-text">
            {submit.pendingPoll.status === 'failed' || submit.pendingPoll.error
              ? '判分暂时没跑成。你的作答已经存住，系统会自动补判，不需要重交。'
              : '这份作答在排队判分，不需要重交。可以先做下一题，结果稍后到。'}
          </p>
          <div className="un-ps-actions">
            <Button variant="secondary" disabled={advancing} onClick={onDone}>
              {advancing ? '下一题准备中…' : '先继续'}
            </Button>
          </div>
        </div>
      );
    } else if (phase === 'confidence') {
      // YUK-444 — confidence before the verdict; observe-only, never scored. 跳过 sends nothing.
      result = (
        <div className="un-ps-result">
          <p className="un-ps-result-text">看结果之前，你有几分把握？</p>
          {/* biome-ignore lint/a11y/useSemanticElements: a row of pill buttons, not a form field set. */}
          <div className="un-ps-scale" role="group" aria-label="把握程度，1 到 5">
            {[1, 2, 3, 4, 5].map((n) => (
              <Button
                key={n}
                variant={submit.selfConfidence === n ? 'primary' : 'secondary'}
                size="sm"
                aria-label={`把握 ${n} 分（共 5 分）`}
                onClick={() => submit.revealVerdict(n)}
              >
                {n}
              </Button>
            ))}
            <Button variant="quiet" size="sm" onClick={() => submit.revealVerdict(null)}>
              跳过
            </Button>
          </div>
          <p className="un-ps-hint">1 = 全靠猜 · 5 = 十拿九稳 · 不计分</p>
        </div>
      );
    } else if (judgmentPhase) {
      const feedback = displayedPreview;
      result = (
        <div className="un-ps-result" data-tone={verdict?.tone}>
          <Judgment
            phase={judgmentPhase}
            tone={verdict?.tone ?? 'neutral'}
            label={verdict?.label ?? ''}
            checkingLabel="正在判"
          >
            {feedback && verdict ? (
              <div className="un-ps-judgment-body">
                {verdict.note && <p className="un-ps-hint">{verdict.note}</p>}
                {/* YUK-1438 — when the system could not grade, feedback_md is for operators. */}
                {feedback.coarse_outcome === 'unsupported' ? (
                  <p className="un-ps-result-text">
                    {submit.autoCommitted || submit.committedPreview
                      ? '这题暂时没法自动判，这次作答已经存下了。可以继续下一题，或者返回练习跳过它。'
                      : '这题暂时没法自动判。可以先自己评一下，或者返回练习跳过这题。'}
                  </p>
                ) : feedback.feedback_md ? (
                  <MathMarkdown notation={notation} className="un-ps-prose un-ps-result-text">
                    {feedback.feedback_md}
                  </MathMarkdown>
                ) : null}
                {q.reference_md && (
                  <div className="un-ps-reference">
                    <span className="un-ps-hint">参考答案</span>
                    <MathMarkdown notation={notation} className="un-ps-prose">
                      {q.reference_md}
                    </MathMarkdown>
                  </div>
                )}
              </div>
            ) : (
              <div />
            )}
          </Judgment>

          {feedback && (
            <>
              {/* YUK-432 — objective questions were rated automatically; open questions keep the
                  manual rating (default = the suggestion). Unknown points: the server settles it. */}
              {!submit.autoCommitted && !unknownScore && (
                <div className="un-ps-rate">
                  <span className="un-ps-actions-label">按这次的情况安排复习：</span>
                  {RATINGS.map((g) => (
                    <ChipToggle
                      key={g}
                      pressed={submit.rating === g}
                      onPressedChange={() => submit.setRating(g)}
                    >
                      {RATING_LABEL[g]}
                    </ChipToggle>
                  ))}
                  <span className="un-ps-hint">
                    {feedback.suggested_rating
                      ? `建议：${RATING_LABEL[feedback.suggested_rating]}`
                      : '这次没有建议，自己选一个'}
                  </span>
                </div>
              )}

              <div className="un-ps-actions">
                {/* Self-rating only works before a result is recorded (YUK-1438 review). */}
                {feedback.coarse_outcome === 'unsupported' &&
                  !submit.autoCommitted &&
                  !submit.committedPreview && (
                    <Button variant="secondary" onClick={submit.startSelfRate}>
                      自己评一下
                    </Button>
                  )}
                {submit.autoCommitted ? (
                  <Button
                    variant="primary"
                    disabled={submit.committing || advancing}
                    onClick={onDone}
                  >
                    {advancing ? '下一题准备中…' : '下一题'}
                  </Button>
                ) : unknownScore ? (
                  <Button
                    variant="primary"
                    disabled={submit.committing || advancing}
                    // Required wire fallback only; auto_rate leaves the actual rating to the server.
                    onClick={() =>
                      void submit.commit({ withAppeal: false, rating: 'hard', autoRate: true })
                    }
                  >
                    {advancing
                      ? '下一题准备中…'
                      : submit.committing
                        ? '正在记下…'
                        : '记下作答，下一题'}
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    disabled={submit.committing || advancing || !submit.rating}
                    onClick={() =>
                      submit.rating &&
                      void submit.commit({ withAppeal: false, rating: submit.rating })
                    }
                  >
                    {advancing ? '下一题准备中…' : submit.committing ? '正在记下…' : '确认，下一题'}
                  </Button>
                )}
                {/* YUK-432 (FINDING 2) — appeal stays available after an automatic commit when
                    there is an anchor to appeal. */}
                {appealEntryAvailable({
                  phase,
                  appealOpen: appeal.open,
                  autoCommitted: submit.autoCommitted,
                  autoCommitJudgeEventId: submit.autoCommitJudgeEventId,
                }) && (
                  <button
                    type="button"
                    className="un-ps-link un-hit"
                    aria-expanded={false}
                    aria-controls={id('appeal')}
                    onClick={() => appeal.setOpen(true)}
                  >
                    觉得判得不对？说明理由重判
                  </button>
                )}
              </div>

              <Expand open={appeal.open} id={id('appeal')}>
                <div className="un-ps-appeal">
                  <textarea
                    className="un-ps-textarea"
                    rows={2}
                    value={appeal.text}
                    placeholder="说说为什么，比如「我的写法和参考答案是等价的」"
                    onChange={(e) => appeal.setText(e.target.value)}
                    aria-label="重判理由"
                  />
                  <div className="un-ps-actions">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={
                        !appeal.text.trim() ||
                        submit.committing ||
                        advancing ||
                        (submit.autoCommitted
                          ? !submit.autoCommitJudgeEventId
                          : !submit.rating && !unknownScore)
                      }
                      onClick={() => {
                        // Automatic commit: the review is stored; appeal its anchor only.
                        // Manual: one submit + appeal (unchanged behaviour).
                        if (submit.autoCommitted) void appeal.submitAfterAutoCommit();
                        else if (unknownScore)
                          void submit.commit({ withAppeal: true, rating: 'hard', autoRate: true });
                        else if (submit.rating)
                          void submit.commit({ withAppeal: true, rating: submit.rating });
                      }}
                    >
                      提交重判，先继续
                    </Button>
                    <Button variant="quiet" size="sm" onClick={() => appeal.setOpen(false)}>
                      算了
                    </Button>
                    <span className="un-ps-hint">重判在后台进行，不耽误做下一题</span>
                  </div>
                </div>
              </Expand>
            </>
          )}
        </div>
      );
    }

    // YUK-1497 — the frozen presentation draws the whole question; the per-slot drawing above
    // stays for revisions without one.
    const blocks = draft.presentation;
    const blockSheet = blocks ? (
      <div className="un-ps-sheet-q">
        <span className="un-ps-mainno un-num" role="img" aria-label={`第 ${pos} 题`}>
          {pos}
        </span>
        <div className="un-ps-stem">
          <PresentationBlocks
            presentation={blocks}
            issued={{ faces, materials: frozen.materials, slots: frozen.response_spec.slots }}
            entries={draft.responses.entries}
            onEntriesChange={draft.updateResponses}
            notation={notation}
            disabled={answerLocked}
            submitting={submit.judging || submit.committing}
            submitted={
              !!ready.accepted ||
              submit.answerRecorded ||
              !!submit.pendingRun ||
              phase !== 'answering'
            }
            onUploadingChange={(slotId, on) => draft.trackUpload(`free:${slotId}`, on)}
            unreceipted={draft.unreceipted}
            onUnreceiptedChange={draft.setSlotUnreceipted}
          />
        </div>
        <QuoteButton text={stemText} what="题目" onQuote={quoteToCopilot} />
      </div>
    ) : null;

    const hasStem = !hasPassage || figures.length > 0 || !multiPart;
    const sheet = (
      <article className="un-ps-sheet" aria-label="题目与作答">
        {blockSheet}
        {!blocks && hasStem && (
          <div className="un-ps-sheet-q">
            <span className="un-ps-mainno un-num" role="img" aria-label={`第 ${pos} 题`}>
              {pos}
            </span>
            {stemBlock}
            {!multiPart && <QuoteButton text={stemText} what="题目" onQuote={quoteToCopilot} />}
          </div>
        )}
        {conflict && (
          <div className="un-ps-indent">
            <DraftConflictPanel view={conflict} />
          </div>
        )}
        {!blocks && answerFields}
        {extras}
        {actionBar}
        {result && (
          <section
            className="un-ps-sheet-result"
            aria-label="结果"
            aria-live="polite"
            ref={reportResult}
          >
            {result}
          </section>
        )}
        <AttemptHistory events={question.timelineEvents} headingId={id('history')} />
      </article>
    );

    // A block tree places its own passage (passage_layout).
    if (!hasPassage || blocks) return sheet;
    // R9: the passage stays pinned on the left and scrolls on its own; questions on the right.
    return (
      <div className="un-ps-split" data-pane={pane}>
        <div className="un-ps-pane-switch">
          {/* Provisional (design doc §11): on phones a switch keeps the passage one tap away
              instead of stacking it above the questions. */}
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
        <section className="un-ps-passage" aria-label="文章">
          {passages.map((m) => (
            <div key={m.material_id} className="un-ps-passage-block">
              <div className="un-ps-passage-head">
                {m.caption && <p className="un-ps-passage-title">{m.caption}</p>}
                <QuoteButton text={m.content_md ?? ''} what="这段文章" onQuote={quoteToCopilot} />
              </div>
              <div data-quotable="">
                <MathMarkdown notation={notation} className="un-ps-prose">
                  {m.content_md ?? ''}
                </MathMarkdown>
              </div>
            </div>
          ))}
        </section>
        <div className="un-ps-questions">{sheet}</div>
      </div>
    );
  }

  const insets = {
    '--un-ps-top': `${shellTop || 0}px`,
    '--un-ps-bottom': `${shellBottom || 0}px`,
  } as CSSProperties;

  return (
    <UiNextRoot className="un-ps-root">
      <div
        className="un-ps"
        style={insets}
        data-screen-label={`散题作答 · ${item.ref_id}`}
        ref={attachPage}
      >
        <div
          className={
            frozen?.materials.some((m) => m.kind === 'passage')
              ? 'un-ps-column un-ps-column-wide'
              : 'un-ps-column'
          }
        >
          {banner}
          {/* YUK-1473 — what leaves and arrives when the page moves to the next question in
              place (advance-motion): everything below the banner. */}
          <div className="un-ps-swap" data-swap-body="">
            {body}
          </div>
        </div>
      </div>
      <QuoteBubble
        selection={quoteSel.selection}
        onQuote={(passage) => {
          quoteToCopilot(passage.text, passage.rect);
          quoteSel.clear();
        }}
      />
      <FigureLightbox
        open={zoomed !== null}
        onClose={() => setZoomed(null)}
        assetId={zoomed?.asset_id ?? ''}
        label={zoomed?.alt_text ?? zoomed?.caption ?? '题目配图'}
      />
      {q && (
        <SoloCoach
          open={coachOpen}
          session={coachSession}
          onClose={() => setCoachOpen(false)}
          question={q}
          issuanceId={ready?.id}
        />
      )}
    </UiNextRoot>
  );
}
