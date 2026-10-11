// YUK-1473 — one practice question with the learning companion beside it, in the loft design
// language (checkpoint 1, redone). Submission, judging, appeal and drafts run through the same hook
// as PfSolo (use-practice-submit), so the API calls, query keys and idempotency ids are identical;
// only the rendering is new.
//
// Composition (docs/design/2026-10-07-ui-visual-direction.md):
// - banner: eyebrow (source · position · minutes), serif title, state chips, and the one mascot in
//   the banner's slot (B1: 128px, 84px on phones; on phones it tucks into the page bar, B3);
// - 题目 → 我的作答 (with the judgment in place, R3) → 作答记录, in one reading column (R1, R2);
//   passage items keep the passage pinned left and the questions right (R9);
// - the companion floats on the right (C1, 384px); on phones it is the bottom sheet (C2).
// Layers (T3, T7): page → cards (flat, no shadow) → floating companion → sheet / lightbox → toast.
// Glass only on floating layers: the companion, the selection bubble, the lightbox.
// Motion (M1–M6): the title morphs from the stream row (PracticeFacePage), quoted text flies into
// the companion's composer, submit → judgment settles in place, the mascot thinks while the
// companion works and turns a petal when a reply is recorded or a result lands.

import { ArrowLeft, Eye, MessageSquareQuote } from 'lucide-react';
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
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
  CompanionStatus,
  Expand,
  IconButton,
  Judgment,
  type JudgmentPhase,
  MASCOT_SIZE,
  MascotDock,
  MascotSlot,
  PHONE_MEDIA,
  Segmented,
  type SheetSnap,
  Toaster,
  UiNextRoot,
  flyQuote,
  useMascot,
  useMascotActivity,
  useToaster,
} from '@/ui-next/public';
import { practiceMorphKey, practiceSourceLabel } from '../PfStream';
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
import { QuoteBubble, type QuotedPassage, clipQuote, useQuotableSelection } from './QuoteSelection';
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

/** The mascot's resting angle on question pages (B2; the loft prototype's question rest). */
const QUESTION_REST = { x: -6, y: -12, z: 8 } as const;

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

/**
 * How much of the top and bottom of the screen the retained shell covers with its own sticky
 * bars. Transitional: the page lives inside the retained shell until the migration line swaps it,
 * so sticky layers sit below its top bar and the phone sheet peeks above its tab bar
 * (YUK-1473 checkpoint 1, owner decision).
 */
function useShellInsets(): { top: number; bottom: number } {
  const [insets, setInsets] = useState({ top: 0, bottom: 0 });
  useLayoutEffect(() => {
    const topBar = document.querySelector<HTMLElement>('.main > .topbar');
    const tabBar = document.querySelector<HTMLElement>('.mobile-tabbar');
    const shown = (el: HTMLElement | null) =>
      el && getComputedStyle(el).display !== 'none' ? el.offsetHeight : 0;
    const measure = () => {
      const next = { top: shown(topBar), bottom: shown(tabBar) };
      setInsets((prev) => (prev.top === next.top && prev.bottom === next.bottom ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (topBar) ro.observe(topBar);
    if (tabBar) ro.observe(tabBar);
    return () => ro.disconnect();
  }, []);
  return insets;
}

/** The composer of whichever embedded companion is mounted (panel or sheet). */
function companionComposer(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.un-pn-root [data-companion-composer]');
}

/** One question page. The mascot hooks need <UiNextRoot>, so the page body renders inside it. */
export function PracticeNextSolo(props: PracticeNextSoloProps) {
  return (
    <UiNextRoot className="un-pn-root">
      <PracticeNextSoloPage {...props} />
    </UiNextRoot>
  );
}

function PracticeNextSoloPage({
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
  const embedded = companion === 'embedded';

  // A new question opens at its top, so its title is where the stream row's title flies to (M4).
  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, []);

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
  const shell = useShellInsets();
  // One Dock instance only: it goes into the panel on wide screens, into the sheet on phones.
  const isPhone = useSyncExternalStore(subscribePhone, readPhone, () => false);
  const [companionBusy, setCompanionBusy] = useState(false);
  const [zoomed, setZoomed] = useState<MaterialView | null>(null);
  const [pane, setPane] = useState<'passage' | 'questions'>('questions');

  // ── The mascot follows real state only (B2, C3): it thinks while the embedded companion works,
  // and turns one petal when a reply's committed turn is re-read or a judgment lands.
  const [recordedReply, setRecordedReply] = useState<string | undefined>(undefined);
  useMascotActivity({ thinking: embedded && companionBusy, settleKey: recordedReply });
  const mascot = useMascot();
  const landedVerdict = useRef<JudgeFeedback | null>(null);
  useEffect(() => {
    if (!displayedPreview || landedVerdict.current === displayedPreview) return;
    landedVerdict.current = displayedPreview;
    mascot.advance();
  }, [displayedPreview, mascot]);

  // ── Quote into the conversation (M6): the passage lifts off the page and lands in the composer.
  const mainRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<{ key: number; text: string } | null>(null);
  const flight = useRef<(() => void) | null>(null);
  useEffect(() => () => flight.current?.(), []);
  const quoteSel = useQuotableSelection(mainRef, embedded);
  const quote = useCallback(({ text, rect }: QuotedPassage) => {
    const clipped = clipQuote(text);
    if (!clipped) return;
    // On phones the sheet rises first; the flight tracks the composer while it moves (C4).
    if (window.matchMedia(PHONE_MEDIA).matches) {
      setSheet((snap) => (snap === 'full' ? snap : 'half'));
    }
    flight.current?.();
    flight.current = flyQuote({
      from: rect,
      content: clipped,
      to: companionComposer,
      onLand: () => {
        flight.current = null;
        setDraft((prev) => ({ key: (prev?.key ?? 0) + 1, text: `「${clipped}」\n` }));
      },
    });
  }, []);
  const quoteBlock = (text: string, el: Element | null | undefined) =>
    quote({ text, rect: el?.getBoundingClientRect() ?? null });

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

  /** A small "引用到学习伙伴" for a block of question text; the keyboard path to M6 (A4). */
  const quoteButton = (text: string, what: string) =>
    embedded ? (
      <IconButton
        label={`把${what}引用到学习伙伴`}
        className="un-pn-quote-btn"
        icon={<MessageSquareQuote size={14} />}
        onClick={(e) =>
          quoteBlock(
            text,
            e.currentTarget.closest('[data-quote-block]')?.querySelector('[data-quote-text]'),
          )
        }
      />
    ) : null;

  const header = (
    <div className="un-pn-companion-head">
      <span className="un-pn-companion-name">学习伙伴</span>
      <CompanionStatus thinking={embedded && companionBusy} />
    </div>
  );
  // C1 asks for "正在看：…". The companion can't see the question yet (backend gap), so it says so
  // instead of pretending, and points at the way to show it: quoting.
  const blindNote = (
    <p className="un-pn-companion-empty">
      它现在还看不到这道题的内容。想问这道题，选中题目里的话引用给它，或者把卡住的地方写进问题里。
    </p>
  );
  const companionBody = (where: 'panel' | 'sheet') => {
    if (!embedded) {
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
      <div className="un-pn-companion-live" data-snap={where === 'sheet' ? sheet : undefined}>
        <p className="un-pn-companion-ctx">
          <Eye size={13} aria-hidden="true" />
          还看不到这道题 · 可以引用题目里的话
        </p>
        <div className="un-pn-dock">
          <CopilotDock
            variant="embedded"
            pathname={window.location.pathname}
            navigate={navigate}
            onRevealRequest={() => setSheet((snap) => (snap === 'full' ? snap : 'half'))}
            onBusyChange={setCompanionBusy}
            onReplyRecorded={setRecordedReply}
            insertDraft={draft}
            emptyHint={blindNote}
          />
        </div>
      </div>
    );
  };

  const stateChip =
    s.accepted || s.autoCommitted ? (
      <Chip tone="accent">已提交</Chip>
    ) : lastAttempt ? (
      <Chip tone={HISTORY_TEXT[lastAttempt.outcome].tone}>
        上次 · {HISTORY_TEXT[lastAttempt.outcome].label}
      </Chip>
    ) : q ? (
      <Chip>第一次做</Chip>
    ) : null;

  // B3: on phones a slim page bar carries the way back, the title and the mascot's dock.
  const phoneBar = (
    <header className="un-pn-phonebar">
      <IconButton
        label="返回练习"
        icon={<ArrowLeft size={18} />}
        disabled={s.returning}
        onClick={() => void s.handleBack()}
      />
      <span className="un-pn-phonebar-title">{title}</span>
      <MascotDock />
    </header>
  );

  const banner = (
    <header className="un-pn-banner">
      <div className="un-pn-banner-text">
        <div className="un-pn-back">
          <Button
            variant="quiet"
            size="sm"
            disabled={s.returning}
            onClick={() => void s.handleBack()}
          >
            <ArrowLeft size={14} aria-hidden="true" />
            返回练习
          </Button>
        </div>
        <p className="un-pn-eyebrow">
          {practiceSourceLabel(item.source)} · 第 {pos} / {total} 题
          {item.estimated_minutes ? ` · 约 ${item.estimated_minutes} 分钟` : ''}
        </p>
        <h1 className="un-pn-title" data-morph={practiceMorphKey(item.id)}>
          {title}
        </h1>
        <div className="un-pn-chips">
          {q?.labels
            .filter((l) => l.name !== title)
            .map((l) => (
              <Chip key={l.id}>{l.name}</Chip>
            ))}
          {stateChip}
        </div>
      </div>
      <MascotSlot
        className="un-pn-mascot"
        size={MASCOT_SIZE.read}
        phoneSize={MASCOT_SIZE.readPhone}
        rest={QUESTION_REST}
        glow={9}
      />
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
    const figuresEl =
      figures.length > 0 ? (
        <div className="un-pn-figures">{figures.map(renderMaterial)}</div>
      ) : null;
    const stemText = faces.map((f) => f.prompt_md).join('\n');

    const questionSection = (
      <section className="un-pn-section" aria-labelledby="un-pn-question" data-quote-block="">
        <div className="un-pn-section-head">
          <h2 id="un-pn-question" className="un-pn-h2">
            题目
          </h2>
          {!multiPart && stemText.trim() && quoteButton(stemText, '题目')}
        </div>
        <div className="un-pn-stem" data-lone={lone || undefined}>
          {lone && figuresEl}
          {!multiPart && (
            <div className="un-pn-faces" data-quotable="" data-quote-text="">
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
          {!lone && figuresEl}
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
          {faces.map((face, index) => {
            const no = face.question_no ?? `(${index + 1})`;
            return (
              <li key={face.part_id} className="un-pn-part" data-quote-block="">
                <div className="un-pn-face">
                  <span className="un-pn-face-no">{no}</span>
                  <div data-quotable="" data-quote-text="">
                    <MathMarkdown notation={notation} className="un-pn-prose">
                      {face.prompt_md}
                    </MathMarkdown>
                  </div>
                  {quoteButton(`${no} ${face.prompt_md}`, `第 ${no} 问`)}
                </div>
                {slotsOf(face.part_id).length > 0 && (
                  <div className="un-pn-answer">{slotsOf(face.part_id).map(renderSlot)}</div>
                )}
              </li>
            );
          })}
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

    // Submit → judgment (R3): one element goes from "正在判" to the result in place, and the
    // explanation opens beneath it. Open questions stop in between for the confidence beat.
    const verdict = displayedPreview ? verdictWords(displayedPreview) : null;
    let judgmentPhase: JudgmentPhase | null = null;
    if (phase === 'feedback' && displayedPreview) judgmentPhase = 'settled';
    else if (phase === 'answering' && s.judging && !s.pendingRun) judgmentPhase = 'checking';

    const resultSection =
      s.pendingRun || phase !== 'answering' || judgmentPhase ? (
        <section className="un-pn-section" aria-labelledby="un-pn-result" aria-live="polite">
          <h2 id="un-pn-result" className="un-pn-h2">
            结果
          </h2>
          {s.pendingRun ? (
            <div className="un-pn-result">
              {/* Not the running judgment line: this can take minutes, and nothing changes
                  here until the result arrives (M1). */}
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
          ) : judgmentPhase ? (
            <div className="un-pn-result" data-tone={verdict?.tone}>
              <Judgment
                phase={judgmentPhase}
                tone={verdict?.tone ?? 'neutral'}
                label={verdict?.label ?? ''}
                checkingLabel="正在判"
              >
                {displayedPreview && verdict ? (
                  <div className="un-pn-judgment-body">
                    {verdict.note && <p className="un-pn-hint">{verdict.note}</p>}
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
                  </div>
                ) : (
                  <div />
                )}
              </Judgment>

              {displayedPreview && (
                <>
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
                            else if (s.rating)
                              void s.commit({ withAppeal: true, rating: s.rating });
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
                </>
              )}
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
              <li
                key={e.event_id}
                data-tone={e.kind === 'attempt' ? HISTORY_TEXT[e.outcome].tone : 'neutral'}
              >
                <span className="un-pn-history-dot" aria-hidden="true" />
                <span className="un-pn-history-day">{formatDay(e.created_at_sec)}</span>
                {e.kind === 'attempt' ? (
                  <span className="un-pn-history-line">
                    <span className="un-pn-history-outcome">{HISTORY_TEXT[e.outcome].label}</span>
                    {e.cause?.primary_label && (
                      <span className="un-pn-history-cause">{e.cause.primary_label}</span>
                    )}
                  </span>
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
          {/* Provisional (design doc §11, owner checkpoint pending): on phones a switch keeps
              the passage one tap away instead of stacking it above the questions. */}
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
            <div key={m.material_id} className="un-pn-passage-block" data-quote-block="">
              <div className="un-pn-passage-head">
                {m.caption && <p className="un-pn-passage-title">{m.caption}</p>}
                {quoteButton(m.content_md ?? '', '这段文章')}
              </div>
              <div data-quotable="" data-quote-text="">
                <MathMarkdown notation={notation} className="un-pn-prose">
                  {m.content_md ?? ''}
                </MathMarkdown>
              </div>
            </div>
          ))}
        </section>
        <div className="un-pn-questions">{questionColumn}</div>
      </div>
    ) : (
      questionColumn
    );
  }

  const insets = {
    '--un-pn-top': `${shell.top}px`,
  } as CSSProperties;

  return (
    <div className="un-pn" style={insets}>
      <div className="un-pn-main un-page-enter" ref={mainRef}>
        <div className={hasPassage ? 'un-pn-column un-pn-column-wide' : 'un-pn-column'}>
          {phoneBar}
          {banner}
          {body}
        </div>
      </div>
      {/* C1: a floating layer beside the reading column, never over it. Glass (T3: floating). */}
      <div className="un-pn-aside un-glass">
        <CompanionPanel open label="学习伙伴" header={header}>
          {companionBody('panel')}
        </CompanionPanel>
      </div>
      <div className="un-pn-phone-sheet">
        <BottomSheet
          label="学习伙伴"
          snap={sheet}
          onSnapChange={setSheet}
          bottomInset={shell.bottom}
          header={header}
        >
          {companionBody('sheet')}
        </BottomSheet>
      </div>
      <QuoteBubble
        selection={quoteSel.selection}
        onQuote={(passage) => {
          quote(passage);
          quoteSel.clear();
        }}
      />
      <FigureLightbox
        open={zoomed !== null}
        onClose={() => setZoomed(null)}
        assetId={zoomed?.asset_id ?? ''}
        label={zoomed?.alt_text ?? zoomed?.caption ?? '题目配图'}
      />
      <Toaster toasts={toaster.toasts} dismiss={toaster.dismiss} />
    </div>
  );
}
