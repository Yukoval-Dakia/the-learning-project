// YUK-1473 — existing practice engine and lifecycle, rendered by the cleanroom M3E surface.
import { type Ref, useCallback, useId, useState } from 'react';
import type { PracticeIssuanceDtoT } from '@/core/schema/assessment';
import { REASONING_TRACE_MAX_LEN } from '@/kernel/limits';
import { CollapsibleList } from '@/ui/primitives/CollapsibleList';
import type { ChipTone } from '@/ui-next/public';
import type { AttemptTimelineEvent } from '../attempt-timeline-adapter';
import type { StreamItem } from '../practice-api';
import { type PracticeToast, type Rating, usePracticeSubmit } from '../use-practice-submit';
import { FigureLightbox } from './FigureLightbox';
import { PracticePresentation } from './PracticePresentation';
import { QuoteBubble, clipQuote, quoteToCompanion, useQuotableSelection } from './QuoteSelection';
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
  titleRef?: Ref<HTMLHeadingElement>;
}

type MaterialView = PracticeIssuanceDtoT['materials'][number];

const RATING_LABEL: Record<Rating, string> = { again: '再练', hard: '模糊', good: '掌握' };

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

/** A question opens at its top (ref callback on the banner, which mounts once per question). */
function startAtTop(node: HTMLElement | null) {
  if (node) window.scrollTo({ top: 0, behavior: 'instant' });
}

/** Where a quote button's text sits on the page: the block it belongs to. */
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
  titleRef,
}: PracticeSoloProps) {
  const [coachOpen, setCoachOpen] = useState(false);
  // How many times the hint drawer has been opened; each opening starts a fresh ladder (YUK-1483).
  const [coachSession, setCoachSession] = useState(0);
  const openCoach = () => {
    setCoachOpen(true);
    setCoachSession((n) => n + 1);
  };
  const [zoomed, setZoomed] = useState<MaterialView | null>(null);
  // While a layer covers the page (hint drawer, figure zoom), ⌘Enter and the number keys pause.
  const hotkeysSuspended = coachOpen || zoomed !== null;
  const quoteSel = useQuotableSelection();
  const uid = useId();
  const id = (name: string) => `${uid}-${name}`;

  const quoteToCopilot = (text: string, _from: DOMRect | null) => {
    const clipped = clipQuote(text);
    if (clipped) quoteToCompanion(item, clipped);
  };

  // M13 — once a result is on screen, the host may read the next question ahead (a GET only).
  // The result section's ref callback says so when it attaches; the host keeps it to once.
  const reportResult = useCallback(
    (node: HTMLElement | null) => {
      if (node) onResultShown?.(item);
    },
    [onResultShown, item],
  );

  const attachTitle = useCallback(
    (node: HTMLHeadingElement | null) => {
      startAtTop(node);
      if (typeof titleRef === 'function') return titleRef(node);
      if (titleRef) titleRef.current = node;
    },
    [titleRef],
  );
  const engine = usePracticeSubmit({
    item,
    sessionId,
    onDone,
    onBack,
    onCommittedBack,
    addToast,
    hotkeysSuspended,
  });
  const { question, issuance } = engine;
  const q = question.data;
  const ready = issuance.status === 'ready' ? issuance : null;

  return (
    <div data-screen-label={`散题作答 · ${item.ref_id}`}>
      <div data-swap-body="">
        <PracticePresentation
          engine={engine}
          item={item}
          pos={pos}
          total={total}
          advancing={advancing}
          hotkeysSuspended={hotkeysSuspended}
          reasoningTraceMaxLength={REASONING_TRACE_MAX_LEN}
          onBack={onBack}
          onDone={onDone}
          onHint={openCoach}
          onQuote={(text) => quoteToCopilot(text, null)}
          onZoom={setZoomed}
          lifecycle={{
            titleRef: attachTitle,
            quotableRef: quoteSel.attach,
            resultRef: reportResult,
          }}
          history={<AttemptHistory events={question.timelineEvents} headingId={id('history')} />}
          overlays={
            <>
              <QuoteBubble
                selection={quoteSel.selection}
                onQuote={(passage) => {
                  quoteToCopilot(passage.text, passage.rect);
                  quoteSel.clear();
                }}
              />
              <FigureLightbox
                presentation="cleanroom"
                open={zoomed !== null}
                onClose={() => setZoomed(null)}
                assetId={zoomed?.asset_id ?? ''}
                label={zoomed?.alt_text ?? zoomed?.caption ?? '题目配图'}
              />
              {q && (
                <SoloCoach
                  presentation="cleanroom"
                  open={coachOpen}
                  session={coachSession}
                  onClose={() => setCoachOpen(false)}
                  question={q}
                  issuanceId={ready?.id}
                />
              )}
            </>
          }
        />
      </div>
    </div>
  );
}
