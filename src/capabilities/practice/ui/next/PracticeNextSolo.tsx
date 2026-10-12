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
// Next question: the page stays mounted; the next question loads out of sight while the finished
// one stays readable, then the old column drifts up and fades as the new one rises in, the
// position rolls, the title crossfades and the page glides back to the top (M3: one swap at a
// time; reduced motion: an instant swap).

import { ArrowLeft, Camera, Eye, MessageSquareQuote, PenLine, Sparkles, X } from 'lucide-react';
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useId,
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
import { useCopilotOpenSignal } from '@/ui/lib/use-copilot-dwell';
import {
  BottomSheet,
  Button,
  Chip,
  ChipToggle,
  type ChipTone,
  CompanionPanel,
  CompanionStatus,
  DURATION,
  Expand,
  IconButton,
  Judgment,
  type JudgmentPhase,
  MASCOT_SIZE,
  MascotDock,
  MascotSlot,
  PHONE_MEDIA,
  RollNumber,
  Segmented,
  type SheetSnap,
  Toaster,
  UiNextRoot,
  flyQuote,
  prefersReducedMotion,
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
import './practice-next-answer.css';
import './practice-next-paper.css';
import './practice-next-focused.css';

export type PracticeCompanionMode = 'embedded' | 'none';

/**
 * How the question and the answer are laid out (owner review 2026-10-11 22:11: two redesigns to
 * pick from). `classic` is the current layout and stays the default until the owner picks.
 * - `paper`: question and answer read as one sheet; each answer sits under its own question as a
 *   writing line; a floating glass action bar holds 提交 / 拍照·附件 / 写思路 while answering.
 * - `focused`: the question on a raised card; one answer panel below it with a numbered segment
 *   per part, the actions and then the result at its foot; a wider column beside the companion.
 */
export type PracticeLayout = 'classic' | 'paper' | 'focused';

export interface PracticeNextSoloProps {
  item: StreamItem;
  sessionId?: string | null;
  pos: number;
  total: number;
  onBack: () => void;
  /** 下一题 on `item` (each question passes itself: by then the host may hold the next one). */
  onDone: (item: StreamItem) => void;
  onCommittedBack?: (item: StreamItem) => void;
  /** The host is reading the next item after 下一题; the finished question stays on screen. */
  advancing?: boolean;
  /** A result is showing on `item`: the host can prefetch the next question (M13). */
  onResultShown?: (item: StreamItem) => void;
  /** Route push for links inside companion replies. */
  navigate: (to: string) => void;
  /**
   * `embedded` mounts the Copilot conversation in the companion panel. Only valid when the
   * shell's global Copilot dock is off: the dock owns the open-with-context signal and exactly
   * one may be mounted (CopilotDock `variant`). `none` keeps the honest placeholder.
   */
  companion: PracticeCompanionMode;
  layout?: PracticeLayout;
  /**
   * Whether the 学习伙伴 (the Copilot) is open. It is one thing with one control: the shell's
   * 学习伙伴 button (through `toggleCopilot`), ⌘J, Esc to close, and on phones the sheet itself.
   * Leave it out and the page keeps its own state, remembered per page; closed by default.
   */
  companionOpen?: boolean;
  onCompanionOpenChange?: (open: boolean) => void;
}

/** This page's remembered open/closed state for the companion (C1: each page remembers its own). */
const COMPANION_KEY = 'un-companion-open:practice-question';
function readCompanionOpen(): boolean {
  try {
    return window.localStorage.getItem(COMPANION_KEY) === '1';
  } catch {
    return false;
  }
}
function writeCompanionOpen(open: boolean) {
  try {
    window.localStorage.setItem(COMPANION_KEY, open ? '1' : '0');
  } catch {
    // Private mode or storage off: the state just isn't remembered.
  }
}

/** The block on the reading line, so a reflow can keep it where it was (M7). */
function readingAnchor(
  root: HTMLElement | null,
  line: number,
): { el: Element; top: number } | null {
  const blocks = root?.querySelectorAll(
    '.un-pn-q[data-role="shown"] :is(p, li, h2, figure, textarea, .katex-display, .rs-opt, .un-sb-text, .un-match-item)',
  );
  for (const el of blocks ?? []) {
    const r = el.getBoundingClientRect();
    if (r.height > 0 && r.bottom > line) return { el, top: r.top };
  }
  return null;
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

/** A question in the stage, with its place in the stream when it was handed over. */
interface StageSlot {
  item: StreamItem;
  pos: number;
}

/**
 * The question column's stage. `shown` is the question on screen; `next` mounts out of sight and
 * loads while `shown` stays readable; once `next` is ready they swap and `shown` leaves (drifts up
 * and fades) while the new one rises in, in the same frame. At most one of each, so pressing
 * 下一题 quickly replaces the waiting question instead of stacking motion (M3).
 */
interface Stage {
  shown: StageSlot;
  next: StageSlot | null;
  leaving: StageSlot | null;
  /** Counts swaps; the effects that follow a swap (scroll, focus, announcement) key on it. */
  swaps: number;
}

/** What the banner and the phone bar show for the question on screen. */
interface QuestionHead {
  title: string;
  labels: { id: string; name: string }[];
  state: { label: string; tone?: ChipTone } | null;
  returning: boolean;
  hasPassage: boolean;
}

/** If the next question is still not ready after this long, show it with its own loading state. */
const NEXT_READY_FALLBACK_MS = 8000;
/**
 * How long the leaving question keeps its place. It has faded by --un-t-ui, but it holds the
 * page's height until the glide to the top has finished, so a shorter new question never makes
 * the browser clamp the scroll position mid-glide (that would be a jump).
 */
const LEAVE_MS = DURATION.panel + 40;

/**
 * A short glide back to the top of the page for the new question, interruptible by the reader
 * (wheel, touch, key). Instant under reduced motion. Returns a function that stops it.
 */
function glideToTop(reduced: boolean): () => void {
  const from = window.scrollY;
  if (from <= 1) return () => {};
  if (reduced) {
    window.scrollTo({ top: 0, behavior: 'instant' });
    return () => {};
  }
  const duration = Math.min(DURATION.panel, DURATION.small + from * 0.12);
  const start = performance.now();
  let frame = 0;
  const handBack = ['wheel', 'touchstart', 'keydown'] as const;
  const stop = () => {
    cancelAnimationFrame(frame);
    for (const type of handBack) window.removeEventListener(type, stop);
  };
  for (const type of handBack) window.addEventListener(type, stop, { passive: true });
  const tick = (now: number) => {
    const t = Math.min(1, (now - start) / duration);
    // Close to --un-ease-glide: quick start, long soft landing.
    const eased = 1 - (1 - t) ** 4;
    window.scrollTo({ top: Math.round(from * (1 - eased)), behavior: 'instant' });
    if (t < 1) frame = requestAnimationFrame(tick);
    else stop();
  };
  frame = requestAnimationFrame(tick);
  return stop;
}

/** Text that crossfades to its new value instead of cutting (the title on a question change). */
function SwapText({ text }: { text: string }) {
  const [state, setState] = useState({ now: text, was: null as string | null, n: 0 });
  if (text !== state.now) setState({ now: text, was: state.now, n: state.n + 1 });
  const n = state.n;
  return (
    <span className="un-pn-swap">
      <span key={`now-${n}`} className={state.was === null ? undefined : 'un-pn-swap-in'}>
        {state.now}
      </span>
      {state.was !== null && (
        <span
          key={`was-${n}`}
          className="un-pn-swap-out"
          aria-hidden="true"
          onAnimationEnd={() => setState((p) => (p.n === n ? { ...p, was: null } : p))}
        >
          {state.was}
        </span>
      )}
    </span>
  );
}

/**
 * The steady layers: page chrome, banner (eyebrow, title, chips, mascot slot), the companion and
 * its sheet, the lightbox and toasts. They stay mounted from one question to the next; only the
 * question column below the banner changes (QuestionColumn).
 */
function PracticeNextSoloPage({
  item,
  sessionId,
  pos,
  total,
  onBack,
  onDone,
  onCommittedBack,
  advancing = false,
  onResultShown,
  navigate,
  companion,
  layout = 'classic',
  companionOpen,
  onCompanionOpenChange,
}: PracticeNextSoloProps) {
  const toaster = useToaster();
  const push = toaster.push;
  const notify = useCallback((text: string) => void push(text), [push]);
  const embedded = companion === 'embedded';

  // A question opened from the list starts at its top, so its title is where the stream row's
  // title flies to (M4). Later questions glide there instead (see the swap effect below).
  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  const shell = useShellInsets();
  // One Dock instance only: it goes into the panel on wide screens, into the sheet on phones.
  const isPhone = useSyncExternalStore(subscribePhone, readPhone, () => false);

  // ── The companion is the Copilot: one open/closed state, one control (C1, owner 2026-10-11
  // 22:54). Wide screens: a 384px panel beside the content. Phones: the sheet; closed = peek.
  const [ownOpen, setOwnOpen] = useState(readCompanionOpen);
  const open = companionOpen ?? ownOpen;
  const openRef = useRef(open);
  openRef.current = open;
  const mainRef = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ el: Element; top: number } | null>(null);
  const setOpen = useCallback(
    (next: boolean) => {
      if (next === openRef.current) return;
      // The reading column reflows once; keep the block on the reading line in place (M7).
      anchor.current = window.matchMedia(PHONE_MEDIA).matches
        ? null
        : readingAnchor(mainRef.current, window.innerHeight * 0.3);
      if (onCompanionOpenChange) onCompanionOpenChange(next);
      if (companionOpen === undefined) {
        setOwnOpen(next);
        writeCompanionOpen(next);
      }
    },
    [companionOpen, onCompanionOpenChange],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after each open/close reflow
  useLayoutEffect(() => {
    const a = anchor.current;
    anchor.current = null;
    if (!a?.el.isConnected) return;
    const moved = a.el.getBoundingClientRect().top - a.top;
    if (Math.abs(moved) > 1) window.scrollBy({ top: moved, behavior: 'instant' });
  }, [open]);
  // The 学习伙伴 button (shell topbar or the demo bar) toggles it through the Copilot channel.
  const toggleSeq = useCopilotOpenSignal((st) => st.toggleSeq);
  const seenToggle = useRef(toggleSeq);
  useEffect(() => {
    if (toggleSeq === seenToggle.current) return;
    seenToggle.current = toggleSeq;
    setOpen(!openRef.current);
  }, [toggleSeq, setOpen]);
  // ⌘J toggles; Esc closes when the companion has focus or nothing else does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setOpen(!openRef.current);
        return;
      }
      if (e.key !== 'Escape' || e.defaultPrevented || !openRef.current) return;
      const active = document.activeElement;
      const inCompanion = active?.closest('.un-pn-aside, .un-pn-phone-sheet');
      if (inCompanion || !active || active === document.body) {
        setOpen(false);
        if (inCompanion) mainRef.current?.querySelector<HTMLElement>('.un-pn-title')?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);
  // On phones the sheet is the companion: peek is closed; half or full is open.
  const [raised, setRaised] = useState<Exclude<SheetSnap, 'peek' | 'closed'>>('half');
  const sheet: SheetSnap = open ? raised : 'peek';
  const onSheetSnap = useCallback(
    (next: SheetSnap) => {
      if (next === 'peek' || next === 'closed') {
        setOpen(false);
        return;
      }
      setRaised(next);
      setOpen(true);
    },
    [setOpen],
  );
  const reveal = useCallback(() => setOpen(true), [setOpen]);
  const [companionBusy, setCompanionBusy] = useState(false);
  const [zoomed, setZoomed] = useState<MaterialView | null>(null);

  // ── The mascot follows real state only (B2, C3): it thinks while the embedded companion works,
  // and turns one petal when a reply's committed turn is re-read. A landed judgment turns a petal
  // too; the question column does that, once per verdict.
  const [recordedReply, setRecordedReply] = useState<string | undefined>(undefined);
  useMascotActivity({ thinking: embedded && companionBusy, settleKey: recordedReply });

  // ── Quote into the conversation (M6): the passage lifts off the page and lands in the composer.
  const [draft, setDraft] = useState<{ key: number; text: string } | null>(null);
  const flight = useRef<(() => void) | null>(null);
  useEffect(() => () => flight.current?.(), []);
  const quoteSel = useQuotableSelection(mainRef, embedded);
  const quote = useCallback(
    ({ text, rect }: QuotedPassage) => {
      const clipped = clipQuote(text);
      if (!clipped) return;
      // The companion opens first (on phones the sheet rises); the flight tracks the composer while
      // it moves (C4).
      reveal();
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
    },
    [reveal],
  );
  const quoteBlock = useCallback(
    (text: string, el: Element | null | undefined) =>
      quote({ text, rect: el?.getBoundingClientRect() ?? null }),
    [quote],
  );

  // ── The stage: the host hands over the next item; it loads out of sight, then swaps in.
  const [stage, setStage] = useState<Stage>(() => ({
    shown: { item, pos },
    next: null,
    leaving: null,
    swaps: 0,
  }));
  if (item.id === stage.shown.item.id) {
    if (stage.next || stage.shown.item !== item || stage.shown.pos !== pos) {
      setStage((st) => ({ ...st, shown: { item, pos }, next: null }));
    }
  } else if (stage.next?.item !== item || stage.next.pos !== pos) {
    setStage((st) => ({ ...st, next: { item, pos } }));
  }

  const swapIn = useCallback((id: string) => {
    setStage((st) =>
      st.next?.item.id === id
        ? {
            shown: st.next,
            next: null,
            // Under reduced motion the old question goes at once: an instant swap (M3).
            leaving: prefersReducedMotion() ? null : st.shown,
            swaps: st.swaps + 1,
          }
        : st,
    );
  }, []);

  const nextId = stage.next?.item.id;
  useEffect(() => {
    if (!nextId) return;
    const timer = window.setTimeout(() => swapIn(nextId), NEXT_READY_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [nextId, swapIn]);

  const leaving = stage.leaving;
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(
      () => setStage((st) => (st.leaving === leaving ? { ...st, leaving: null } : st)),
      LEAVE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [leaving]);

  // After a swap: glide to the top, give focus to the new title if it was on the old question,
  // and say which question this is.
  const stageRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [announce, setAnnounce] = useState('');
  const swaps = stage.swaps;
  const shownPos = stage.shown.pos;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per swap; reads the position at that moment
  useLayoutEffect(() => {
    if (swaps === 0) return;
    const stop = glideToTop(prefersReducedMotion());
    const active = document.activeElement;
    if (!active || active === document.body || stageRef.current?.contains(active)) {
      titleRef.current?.focus({ preventScroll: true });
    }
    setAnnounce(`第 ${shownPos} 题`);
    return stop;
  }, [swaps]);

  // ── The banner reads the question on screen; that column reports what it shows.
  const [head, setHead] = useState<QuestionHead | null>(null);
  const backRef = useRef<(() => Promise<void>) | null>(null);
  const waitingNext = advancing || stage.next !== null;
  const goBack = () => {
    // While the next question is on its way, the one on screen is already finished: just leave.
    if (waitingNext) onBack();
    else void backRef.current?.();
  };

  const shownItem = stage.shown.item;
  const title = head?.title ?? shownItem.knowledge_name ?? '这道题';
  const returning = head?.returning ?? false;

  const header = (
    <div className="un-pn-companion-head">
      <Sparkles size={15} className="un-pn-companion-icon" aria-hidden="true" />
      <span className="un-pn-companion-name">学习伙伴</span>
      <CompanionStatus thinking={embedded && companionBusy} />
      <IconButton
        label="收起学习伙伴（⌘J）"
        className="un-pn-companion-close"
        icon={<X size={16} />}
        onClick={() => setOpen(false)}
      />
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
            onRevealRequest={reveal}
            onBusyChange={setCompanionBusy}
            onReplyRecorded={setRecordedReply}
            insertDraft={draft}
            emptyHint={blindNote}
          />
        </div>
      </div>
    );
  };

  // B3: on phones a slim page bar carries the way back, the title and the mascot's dock.
  const phoneBar = (
    <header className="un-pn-phonebar">
      <IconButton
        label="返回练习"
        icon={<ArrowLeft size={18} />}
        disabled={returning}
        onClick={goBack}
      />
      <span className="un-pn-phonebar-title">
        <SwapText text={title} />
      </span>
      <MascotDock />
    </header>
  );

  const banner = (
    <header className="un-pn-banner">
      <div className="un-pn-banner-text">
        <div className="un-pn-back">
          <Button variant="quiet" size="sm" disabled={returning} onClick={goBack}>
            <ArrowLeft size={14} aria-hidden="true" />
            返回练习
          </Button>
        </div>
        <p className="un-pn-eyebrow">
          {practiceSourceLabel(shownItem.source)} · 第 <RollNumber value={shownPos} /> / {total} 题
          {shownItem.estimated_minutes ? ` · 约 ${shownItem.estimated_minutes} 分钟` : ''}
        </p>
        <h1
          ref={titleRef}
          tabIndex={-1}
          className="un-pn-title"
          data-morph={practiceMorphKey(shownItem.id)}
        >
          <SwapText text={title} />
        </h1>
        {/* Keyed by question: the new question's chips fade in with it. */}
        <div
          key={shownItem.id}
          className={swaps > 0 ? 'un-pn-chips un-pn-chips-in' : 'un-pn-chips'}
        >
          {head?.labels.map((l) => (
            <Chip key={l.id}>{l.name}</Chip>
          ))}
          {head?.state && <Chip tone={head.state.tone}>{head.state.label}</Chip>}
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

  const column = (slot: StageSlot, role: QuestionRole) => (
    <QuestionColumn
      key={slot.item.id}
      item={slot.item}
      pos={slot.pos}
      layout={layout}
      role={role}
      sessionId={sessionId}
      embedded={embedded}
      waitingNext={role === 'shown' && waitingNext}
      arrived={role === 'shown' && stage.swaps > 0}
      notify={notify}
      onReady={swapIn}
      onHead={setHead}
      backRef={backRef}
      onBack={onBack}
      onDone={onDone}
      onCommittedBack={onCommittedBack}
      onResultShown={onResultShown}
      onQuote={quoteBlock}
      onZoom={setZoomed}
    />
  );

  const insets = {
    '--un-pn-top': `${shell.top}px`,
    '--un-pn-bottom': `${shell.bottom}px`,
  } as CSSProperties;

  return (
    <div
      className="un-pn"
      data-layout={layout}
      data-companion={open ? 'open' : 'closed'}
      style={insets}
    >
      <div className="un-pn-main un-page-enter" ref={mainRef}>
        <div className={head?.hasPassage ? 'un-pn-column un-pn-column-wide' : 'un-pn-column'}>
          {phoneBar}
          {banner}
          <div className="un-pn-stage" ref={stageRef}>
            {stage.leaving && column(stage.leaving, 'leaving')}
            {column(stage.shown, 'shown')}
            {stage.next && column(stage.next, 'next')}
          </div>
        </div>
        <p className="un-pn-sr" aria-live="polite">
          {announce}
        </p>
      </div>
      {/* C1: a floating layer beside the reading column, never over it. Glass (T3: floating). */}
      <div className="un-pn-aside un-glass" data-open={open || undefined}>
        <CompanionPanel open={open} label="学习伙伴" header={header}>
          {companionBody('panel')}
        </CompanionPanel>
      </div>
      <div className="un-pn-phone-sheet">
        <BottomSheet
          label="学习伙伴"
          snap={sheet}
          onSnapChange={onSheetSnap}
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

/** `shown` is on screen; `next` loads out of sight; `leaving` fades out after a swap. */
type QuestionRole = 'shown' | 'next' | 'leaving';

interface QuestionColumnProps {
  item: StreamItem;
  /** Place in the stream: the main question number in the new layouts. */
  pos: number;
  layout: PracticeLayout;
  role: QuestionRole;
  sessionId?: string | null;
  embedded: boolean;
  /** The host is fetching the next question: the next-question buttons wait, calmly. */
  waitingNext: boolean;
  /** Came in by a swap (rises in), rather than opened from the list. */
  arrived: boolean;
  notify: (text: string) => void;
  onReady: (itemId: string) => void;
  onHead: (head: QuestionHead) => void;
  backRef: { current: (() => Promise<void>) | null };
  onBack: () => void;
  onDone: (item: StreamItem) => void;
  onCommittedBack?: (item: StreamItem) => void;
  onResultShown?: (item: StreamItem) => void;
  onQuote: (text: string, el: Element | null | undefined) => void;
  onZoom: (m: MaterialView) => void;
}

/** One question's content below the banner: 题目 → 我的作答 → 结果 → 作答记录. */
function QuestionColumn({
  item,
  pos,
  layout,
  role,
  sessionId,
  embedded,
  waitingNext,
  arrived,
  notify,
  onReady,
  onHead,
  backRef,
  onBack,
  onDone,
  onCommittedBack,
  onResultShown,
  onQuote,
  onZoom,
}: QuestionColumnProps) {
  const shown = role === 'shown';
  const s = usePracticeSubmit({
    item,
    sessionId,
    onDone: () => onDone(item),
    onBack,
    onCommittedBack: onCommittedBack ? () => onCommittedBack(item) : undefined,
    addToast: notify,
    shown: role !== 'next',
  });
  const { q, frozen, phase, displayedPreview } = s;
  // The new layouts draw their own 拍照/附件 control, which says when an upload is under way.
  const [uploading, setUploading] = useState(false);
  const { setUploading: reportUploading } = s;
  const trackUploading = useCallback(
    (busy: boolean) => {
      setUploading(busy);
      reportUploading(busy);
    },
    [reportUploading],
  );
  // Several questions can be in the page at once during a swap, so ids are per question.
  const uid = useId();
  const id = (name: string) => `${uid}-${name}`;

  // ⌘/Ctrl+Enter submits while answering (same shortcut as PfSolo); only the question on screen.
  const { runJudge } = s;
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (phase !== 'answering') return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        void runJudge();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shown, phase, runJudge]);

  // A landed judgment turns one petal (B2), once per verdict, only on screen.
  const mascot = useMascot();
  const landedVerdict = useRef<JudgeFeedback | null>(null);
  useEffect(() => {
    if (!shown || !displayedPreview || landedVerdict.current === displayedPreview) return;
    landedVerdict.current = displayedPreview;
    mascot.advance();
  }, [shown, displayedPreview, mascot]);

  // While the learner reads the result, the host prefetches the next question (M13).
  const hasResult = !!displayedPreview || !!s.pendingRun;
  const prefetched = useRef(false);
  useEffect(() => {
    if (!shown || !hasResult || prefetched.current) return;
    prefetched.current = true;
    onResultShown?.(item);
  }, [shown, hasResult, item, onResultShown]);

  const [pane, setPane] = useState<'passage' | 'questions'>('questions');

  const timeline = s.timelineEvents;
  const lastAttempt = [...timeline].reverse().find((e) => e.kind === 'attempt');
  const title = item.knowledge_name ?? q?.labels[0]?.name ?? '这道题';
  const notation = q?.notation ?? null;
  const loading =
    !s.qQ.isError &&
    (!q || s.frozenQ.isLoading || (!!frozen && s.restoredIssuanceId !== s.issuanceId));
  const issuanceFailed = !s.qQ.isError && !loading && (s.frozenQ.isError || !frozen);

  // Waiting out of sight: say when there is something to show (content or an error).
  useEffect(() => {
    if (role === 'next' && !loading) onReady(item.id);
  }, [role, loading, item.id, onReady]);

  const passages = (frozen?.materials ?? []).filter(
    (m) => m.kind === 'passage' && m.content_md !== undefined,
  );
  const figures = (frozen?.materials ?? []).filter((m) => !passages.includes(m));
  const hasPassage = passages.length > 0;
  const faces = frozen?.faces ?? [];
  const multiPart = faces.length > 1;
  const lone = !multiPart && figures.length === 1 && figures[0].content_md === undefined;
  const answerLocked = s.returning || phase !== 'answering' || !!s.accepted || !!s.pendingRun;

  // The banner shows the question on screen.
  let state: QuestionHead['state'] = null;
  if (s.accepted || s.autoCommitted) state = { label: '已提交', tone: 'accent' };
  else if (lastAttempt) {
    const h = HISTORY_TEXT[lastAttempt.outcome];
    state = { label: `上次 · ${h.label}`, tone: h.tone };
  } else if (q) state = { label: '第一次做' };
  const head: QuestionHead = {
    title,
    labels: (q?.labels ?? []).filter((l) => l.name !== title).map(({ id, name }) => ({ id, name })),
    state,
    returning: s.returning,
    hasPassage,
  };
  const headKey = JSON.stringify(head);
  // biome-ignore lint/correctness/useExhaustiveDependencies: headKey carries the head's content
  useLayoutEffect(() => {
    if (shown) onHead(head);
  }, [shown, headKey, onHead]);
  useLayoutEffect(() => {
    if (shown) backRef.current = s.handleBack;
  });

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
        hotkeys={
          shown && frozen?.response_spec.slots.length === 1 && s.isChoice && phase === 'answering'
        }
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
            onClick={() => onZoom(m)}
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
          onQuote(
            text,
            e.currentTarget.closest('[data-quote-block]')?.querySelector('[data-quote-text]'),
          )
        }
      />
    ) : null;

  /** In place of a next-question button while the next question is on its way. */
  const preparing = (
    <Button variant="primary" disabled>
      下一题准备中…
    </Button>
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

    const stemBlock = (
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
    );

    const questionSection = (
      <section className="un-pn-section" aria-labelledby={id('question')} data-quote-block="">
        <div className="un-pn-section-head">
          <h2 id={id('question')} className="un-pn-h2">
            题目
          </h2>
          {!multiPart && stemText.trim() && quoteButton(stemText, '题目')}
        </div>
        {stemBlock}
      </section>
    );

    const variant = layout !== 'classic';
    const answering = phase === 'answering' && !s.pendingRun;
    const offerTrace = answering && shouldOfferProcessBox(s.isChoice);
    // Attachments and the trace field have nothing to show once the answer is locked and empty
    // (this used to leave an empty box under a submitted multi-part question).
    const extrasVisible = !answerLocked || s.evidence.length > 0 || (offerTrace && s.showTrace);
    const evidence = (
      <EvidenceComposer
        text=""
        onTextChange={() => {}}
        showText={false}
        attachments={s.evidence}
        onAttachmentsChange={s.setEvidence}
        disabled={answerLocked}
        onUploadingChange={trackUploading}
        inputId={variant ? id('attach') : undefined}
        showAddButton={!variant}
      />
    );
    const traceField = (
      <Expand open={s.showTrace} id={id('trace')}>
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
    );

    const extras = (
      <>
        {evidence}
        {offerTrace && (
          <div className="un-pn-trace">
            <button
              type="button"
              className="un-pn-link un-hit"
              aria-expanded={s.showTrace}
              aria-controls={id('trace')}
              onClick={() => s.setShowTrace(!s.showTrace)}
            >
              {s.showTrace ? '收起思路' : '＋ 记下你的思路（可选，不计分）'}
            </button>
            {traceField}
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
                  disabled={!s.canSubmit || s.committing || waitingNext}
                  onClick={() => void s.commit({ withAppeal: false, rating: grade })}
                >
                  {RATING_LABEL[grade]}
                </Button>
              ))}
              {waitingNext && <span className="un-pn-hint">下一题准备中…</span>}
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
      <section className="un-pn-section" aria-labelledby={id('parts')}>
        <div className="un-pn-section-head">
          <h2 id={id('parts')} className="un-pn-h2">
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
        {(looseSlots.length > 0 || extrasVisible) && (
          <div className="un-pn-answer">
            {looseSlots.map(renderSlot)}
            {extras}
          </div>
        )}
        {submitRow}
      </section>
    ) : (
      <section className="un-pn-section" aria-labelledby={id('answer')}>
        <div className="un-pn-section-head">
          <h2 id={id('answer')} className="un-pn-h2">
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
    const unknownScore = displayedPreview?.coarse_outcome === 'partial_unknown';
    let judgmentPhase: JudgmentPhase | null = null;
    if (phase === 'feedback' && displayedPreview) judgmentPhase = 'settled';
    else if (phase === 'answering' && s.judging && !s.pendingRun) judgmentPhase = 'checking';

    const resultBody = s.pendingRun ? (
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
          {waitingNext ? (
            preparing
          ) : (
            <Button variant="secondary" onClick={() => onDone(item)}>
              先做下一题
            </Button>
          )}
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
            {!s.autoCommitted && !unknownScore && (
              <div className="un-pn-rate">
                <span className="un-pn-actions-label">按这次的情况安排复习：</span>
                {RATINGS.map((g) => (
                  <ChipToggle
                    key={g}
                    pressed={s.rating === g}
                    disabled={waitingNext}
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
                !s.committedPreview &&
                !waitingNext && (
                  <Button variant="secondary" onClick={s.startSelfRate}>
                    自己评一下
                  </Button>
                )}
              {waitingNext ? (
                preparing
              ) : s.autoCommitted ? (
                <Button variant="primary" disabled={s.committing} onClick={() => onDone(item)}>
                  下一题
                </Button>
              ) : unknownScore ? (
                // Points unknown: no rating from the learner; the server settles it (auto_rate).
                <Button
                  variant="primary"
                  disabled={s.committing}
                  onClick={() =>
                    void s.commit({ withAppeal: false, rating: 'hard', autoRate: true })
                  }
                >
                  {s.committing ? '正在记下…' : '记下作答，下一题'}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  disabled={s.committing || !s.rating}
                  onClick={() => s.rating && void s.commit({ withAppeal: false, rating: s.rating })}
                >
                  {s.committing ? '正在记下…' : '确认，下一题'}
                </Button>
              )}
              {!waitingNext &&
                appealEntryAvailable({
                  phase,
                  appealOpen: s.appealOpen,
                  autoCommitted: s.autoCommitted,
                  autoCommitJudgeEventId: s.autoCommitJudgeEventId,
                }) && (
                  <button
                    type="button"
                    className="un-pn-link un-hit"
                    aria-expanded={false}
                    aria-controls={id('appeal')}
                    onClick={() => s.setAppealOpen(true)}
                  >
                    觉得判得不对？说明理由重判
                  </button>
                )}
            </div>

            <Expand open={s.appealOpen} id={id('appeal')}>
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
                      waitingNext ||
                      (s.autoCommitted ? !s.autoCommitJudgeEventId : !s.rating && !unknownScore)
                    }
                    onClick={() => {
                      if (s.autoCommitted) void s.submitAutoCommitAppeal();
                      else if (unknownScore)
                        void s.commit({ withAppeal: true, rating: 'hard', autoRate: true });
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
          </>
        )}
      </div>
    ) : null;

    const resultSection = resultBody ? (
      <section className="un-pn-section" aria-labelledby={id('result')} aria-live="polite">
        <h2 id={id('result')} className="un-pn-h2">
          结果
        </h2>
        {resultBody}
      </section>
    ) : null;

    const historySection =
      timeline.length > 0 ? (
        <section className="un-pn-section" aria-labelledby={id('history')}>
          <h2 id={id('history')} className="un-pn-h2">
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

    const hasStem = !hasPassage || figures.length > 0 || !multiPart;
    const classicColumn = (
      <>
        {hasStem && questionSection}
        {answerSection}
        {resultSection}
        {historySection}
      </>
    );

    // ── The two new layouts share these pieces; CSS under [data-layout] gives each its shape.
    const handedIn = !answering;
    const saveNote = answering ? (
      <SaveStateChip state={s.autosave.state} onRetry={s.autosave.retry} />
    ) : null;
    // Worksheet numbering (owner 2026-10-11 16:44): a filled coral square for the question, a
    // thin coral ring for each part, with the same numbers as the question text.
    const mainNo = (
      <span className="un-pn-mainno un-num" role="img" aria-label={`第 ${pos} 题`}>
        {pos}
      </span>
    );
    const partList = (
      <ol className="un-pn-vparts">
        {faces.map((face, index) => {
          const no = face.question_no ?? `(${index + 1})`;
          const slots = slotsOf(face.part_id);
          return (
            <li key={face.part_id} className="un-pn-vpart" data-quote-block="">
              <span className="un-pn-ring un-num" role="img" aria-label={`第 ${no} 问`}>
                {no.replace(/[()（）\s]/g, '')}
              </span>
              <div className="un-pn-vpart-body">
                <div className="un-pn-vpart-prompt" data-quotable="" data-quote-text="">
                  <MathMarkdown notation={notation} className="un-pn-prose">
                    {face.prompt_md}
                  </MathMarkdown>
                </div>
                {slots.length > 0 && <div className="un-pn-write">{slots.map(renderSlot)}</div>}
              </div>
              <div className="un-pn-vpart-side">
                {layout === 'focused' && handedIn && (
                  <span className="un-pn-vpart-state">已交</span>
                )}
                {quoteButton(`${no} ${face.prompt_md}`, `第 ${no} 问`)}
              </div>
            </li>
          );
        })}
      </ol>
    );
    const answerFields = multiPart ? (
      <>
        {partList}
        {looseSlots.length > 0 && <div className="un-pn-write">{looseSlots.map(renderSlot)}</div>}
      </>
    ) : (
      <div className="un-pn-write">{frozen.response_spec.slots.map(renderSlot)}</div>
    );
    const variantExtras = extrasVisible ? (
      <div className="un-pn-extras">
        {evidence}
        {offerTrace && traceField}
      </div>
    ) : null;

    // While answering: 提交 (or the self-rating), then 拍照/附件 and 写思路. ⌘Enter still submits;
    // it is in the button's title instead of a hint line.
    const actionBar = answering ? (
      // biome-ignore lint/a11y/useSemanticElements: a toolbar of buttons, not a form field set.
      <div
        className={layout === 'paper' ? 'un-pn-bar un-glass' : 'un-pn-bar'}
        role="group"
        aria-label="作答操作"
      >
        <div className="un-pn-bar-main">
          {s.issuanceMode === 'manual' ? (
            <>
              <span className="un-pn-actions-label">做完了？自己评一下：</span>
              {RATINGS.map((grade) => (
                <Button
                  key={grade}
                  variant="secondary"
                  size="sm"
                  disabled={!s.canSubmit || s.committing || waitingNext}
                  onClick={() => void s.commit({ withAppeal: false, rating: grade })}
                >
                  {RATING_LABEL[grade]}
                </Button>
              ))}
            </>
          ) : (
            <Button
              variant="primary"
              className="un-pn-submit"
              disabled={!s.canSubmit}
              title="⌘Enter 也能提交"
              aria-keyshortcuts="Meta+Enter Control+Enter"
              onClick={() => void s.runJudge()}
            >
              {s.judging ? '正在判…' : '提交'}
            </Button>
          )}
        </div>
        <div className="un-pn-bar-tools">
          <Button
            variant="quiet"
            size="sm"
            disabled={answerLocked || uploading}
            onClick={() => document.getElementById(id('attach'))?.click()}
          >
            <Camera size={15} aria-hidden="true" />
            {uploading ? '上传中…' : '拍照/附件'}
          </Button>
          {offerTrace && (
            <Button
              variant="quiet"
              size="sm"
              aria-expanded={s.showTrace}
              aria-controls={id('trace')}
              data-on={s.showTrace || undefined}
              onClick={() => s.setShowTrace(!s.showTrace)}
            >
              <PenLine size={15} aria-hidden="true" />
              {s.showTrace ? '收起思路' : '写思路'}
            </Button>
          )}
        </div>
        {layout === 'paper' && <span className="un-pn-bar-save">{saveNote}</span>}
        {waitingNext && <span className="un-pn-hint">下一题准备中…</span>}
      </div>
    ) : null;

    const resultBlock = (className: string) =>
      resultBody ? (
        <section className={className} aria-label="结果" aria-live="polite">
          {resultBody}
        </section>
      ) : null;

    // A「纸面」: one sheet, question → answers under their own question → bar → result → history.
    const paperColumn = (
      <article className="un-pn-sheet" aria-label="题目与作答">
        {hasStem && (
          <div className="un-pn-sheet-q" data-quote-block="">
            {mainNo}
            {stemBlock}
            {!multiPart && stemText.trim() && quoteButton(stemText, '题目')}
          </div>
        )}
        {answerFields}
        {variantExtras}
        {actionBar}
        {resultBlock('un-pn-sheet-result')}
        {historySection}
      </article>
    );

    // B「分栏卡」: the question card, then one answer panel with the actions / result at its foot.
    const focusedColumn = (
      <>
        {hasStem && (
          <section className="un-pn-qcard" aria-label="题目" data-quote-block="">
            <div className="un-pn-qcard-head">
              {mainNo}
              <span className="un-pn-qcard-meta">
                {multiPart ? `共 ${faces.length} 问，在下面逐问作答` : '题目'}
              </span>
              {!multiPart && stemText.trim() && quoteButton(stemText, '题目')}
            </div>
            {stemBlock}
          </section>
        )}
        <section
          className="un-pn-panel"
          aria-labelledby={id('answer')}
          data-state={handedIn ? 'done' : 'answering'}
          data-tone={handedIn ? (verdict?.tone ?? 'neutral') : undefined}
        >
          <header className="un-pn-panel-head">
            <h2 id={id('answer')} className="un-pn-panel-title">
              我的作答
            </h2>
            {saveNote}
          </header>
          {answerFields}
          {variantExtras}
          {(actionBar || resultBody) && (
            <footer className="un-pn-panel-foot">
              {actionBar}
              {resultBlock('un-pn-panel-result')}
            </footer>
          )}
        </section>
        {historySection}
      </>
    );

    let questionColumn: React.ReactNode = classicColumn;
    if (layout === 'paper') questionColumn = paperColumn;
    else if (layout === 'focused') questionColumn = focusedColumn;

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

  // The question that arrived by a swap rises in; the one that left drifts up and fades (CSS).
  return (
    <div
      className="un-pn-q"
      data-role={role}
      data-arrived={arrived || undefined}
      inert={!shown}
      aria-hidden={shown ? undefined : true}
    >
      {body}
    </div>
  );
}
