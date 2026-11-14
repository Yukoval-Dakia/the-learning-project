// YUK-1473 — existing practice engine and lifecycle, rendered by the cleanroom M3E surface.
import { type Ref, useCallback, useRef, useState } from 'react';
import type { PracticeIssuanceDtoT } from '@/core/schema/assessment';
import { REASONING_TRACE_MAX_LEN } from '@/kernel/limits';
import { useSubjects } from '@/ui/hooks/useSubjects';
import { readCompanionFocus, setCompanionFocus } from '@/ui/lib/use-copilot-dwell';
import { FoldList } from '@/ui-next/primitives/FoldList';
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

/** This try's own record entry lands around its hand-in time; nobody re-answers within this. */
const SAME_TRY_WINDOW_SEC = 2;

const RATING_LABEL: Record<Rating, string> = { again: '再练', hard: '模糊', good: '会了' };

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

/** A question opens at its top (ref callback on the banner, which mounts once per question). */
function startAtTop(node: HTMLElement | null) {
  if (node) window.scrollTo({ top: 0, behavior: 'instant' });
}

/** Where a quote button's text sits on the page: the block it belongs to. */
/**
 * The tries before this one. Closed, it answers the one thing worth knowing while on this question:
 * how the last try went and, when known, what went wrong. Open, the newest 3 (the rest fold, L5).
 */
function AttemptHistory({
  events,
  submittedAt,
  subjectId,
}: {
  events: AttemptTimelineEvent[];
  /** This answer's hand-in time: the record holds this try too once the page is reopened. */
  submittedAt: string | null;
  subjectId: string | null;
}) {
  const { subjects } = useSubjects();
  const cutoff = submittedAt ? Date.parse(submittedAt) / 1000 - SAME_TRY_WINDOW_SEC : null;
  const earlier = cutoff === null ? events : events.filter((e) => e.created_at_sec < cutoff);
  if (earlier.length === 0) return null;

  // A category id ('concept') is named by the subject; an id nobody can name is never shown.
  const causeNames = new Map<string, string>();
  for (const subject of subjects.filter((s) => s.id !== subjectId)) {
    for (const cause of subject.causeCategories ?? []) causeNames.set(cause.id, cause.label);
  }
  for (const cause of subjects.find((s) => s.id === subjectId)?.causeCategories ?? []) {
    causeNames.set(cause.id, cause.label);
  }
  const causeOf = (e: AttemptTimelineEvent) =>
    e.kind === 'attempt' && e.cause
      ? (e.cause.primary_label ?? causeNames.get(e.cause.primary) ?? null)
      : null;
  const causeCounts = new Map<string, number>();
  for (const e of earlier) {
    const cause = causeOf(e);
    if (cause) causeCounts.set(cause, (causeCounts.get(cause) ?? 0) + 1);
  }

  const tries = earlier.filter((e) => e.kind === 'attempt').length;
  const last = earlier.find((e) => e.kind === 'attempt');
  const lastCause = last ? causeOf(last) : null;
  const lastLine =
    last?.kind !== 'attempt'
      ? null
      : lastCause && (causeCounts.get(lastCause) ?? 0) >= 2
        ? `这个错出现过 ${causeCounts.get(lastCause)} 次：${lastCause}`
        : `上次${ATTEMPT_TEXT[last.outcome].label}${lastCause ? `：${lastCause}` : ''}`;

  return (
    <details className="un-st-disclosure">
      <summary>
        <span className="un-ps-history-summary">
          <span>{tries > 0 ? `之前做过 ${tries} 次` : `之前复习过 ${earlier.length} 次`}</span>
          {lastLine && <span className="un-ps-history-last">{lastLine}</span>}
        </span>
      </summary>
      <div className="un-ps-history-body">
        <FoldList
          items={earlier}
          className="un-ps-history"
          renderItem={(e) => {
            if (e.kind === 'review') {
              return (
                <li key={e.event_id} data-tone="neutral">
                  <span className="un-ps-history-day">{formatDay(e.created_at_sec)}</span>
                  <span className="un-ps-history-cause">
                    复习 · 自评「{RATING_LABEL[e.fsrs_rating]}」
                  </span>
                </li>
              );
            }
            const text = ATTEMPT_TEXT[e.outcome];
            const cause = causeOf(e);
            return (
              <li key={e.event_id} data-tone={text.tone}>
                <span className="un-ps-history-day">{formatDay(e.created_at_sec)}</span>
                <span className="un-ps-history-outcome">{text.label}</span>
                {cause && <span className="un-ps-history-cause">{cause}</span>}
              </li>
            );
          }}
        />
      </div>
    </details>
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
  // Each visit restores publications from the server before offering the next step.
  const [coachSession, setCoachSession] = useState(0);
  const openCoach = () => {
    setCoachOpen(true);
    setCoachSession((n) => n + 1);
  };
  const [zoomed, setZoomed] = useState<MaterialView | null>(null);
  // While a layer covers the page (hint drawer, figure zoom), ⌘Enter and the number keys pause.
  const hotkeysSuspended = coachOpen || zoomed !== null;
  const quoteSel = useQuotableSelection();

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
  const latestDraftReader = useRef<typeof engine.draft.readFocus | undefined>(undefined);
  const readSavedDraft = useCallback(() => latestDraftReader.current?.(), []);
  const questionId = q?.id;
  const issuanceId = ready?.id;
  const attachFocus = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node || !questionId || !issuanceId) return;
      const focus = {
        kind: 'question',
        id: questionId,
        title: '当前作答（已保存内容）',
        readSavedDraft,
      };
      setCompanionFocus(focus);
      return () => {
        if (readCompanionFocus()?.readSavedDraft === focus.readSavedDraft) setCompanionFocus(null);
      };
    },
    [questionId, issuanceId, readSavedDraft],
  );

  return (
    <div ref={attachFocus} data-screen-label={`散题作答 · ${item.ref_id}`}>
      <div
        data-swap-body=""
        ref={(node) => {
          latestDraftReader.current = node ? engine.draft.readFocus : undefined;
        }}
      >
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
          history={
            <AttemptHistory
              events={question.timelineEvents}
              submittedAt={ready?.accepted?.submitted_at ?? null}
              subjectId={q?.subject ?? null}
            />
          }
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
                presentation="workspace"
                open={zoomed !== null}
                onClose={() => setZoomed(null)}
                assetId={zoomed?.asset_id ?? ''}
                label={zoomed?.alt_text ?? zoomed?.caption ?? '题目配图'}
              />
              {q && (
                <SoloCoach
                  presentation="workspace"
                  open={coachOpen}
                  session={coachSession}
                  onClose={() => setCoachOpen(false)}
                  question={q}
                  issuanceId={ready?.id}
                  submitted={
                    !!ready?.accepted ||
                    engine.submit.autoCommitted ||
                    engine.submit.answerRecorded ||
                    !!engine.submit.pendingRun ||
                    engine.submit.phase !== 'answering'
                  }
                />
              )}
            </>
          }
        />
      </div>
    </div>
  );
}
