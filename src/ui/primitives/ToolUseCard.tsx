// Wave 5 / T-D3/A — ToolUseCard 三段式 primitive.
// S1 (2026-06-07) — full-anatomy upgrade per claude-design handoff
//   (docs/design/2026-06-07-copilot-tool-use-cards/). The card now carries the
//   complete tool_use vocabulary — header · args · result · meta ribbon ·
//   actions — across five lifecycle states, while staying 100% backward
//   compatible with the original three-section folded summary contract.
//
// Anatomy (top to bottom), every new part OPTIONAL and gracefully omitted:
//   1) header  : tool icon + name + actor tag + status pill (or legacy summary +
//                cost chip + expand toggle — both head shapes coexist)
//   2) args    : function-call args as a labelled key/value list, with a
//                collapsible raw-JSON view (only when `args` provided)
//   3) result  : per-state body — running / done / empty / failed / waiting,
//                each with its own renderer; falls back to the legacy `body`
//   4) ribbon  : model · $cost · latency · confidence · caused_by event chain,
//                every field optional, missing fields silently dropped
//   5) actions : accept / dismiss approval row (waiting state) + a resolved line
//
// Known design traps carried over from chat3.md (do NOT regress):
//   • No fragile fade-in keyframes on result / resolved-line — they could stick
//     at opacity 0. Result + resolved render instantly; only spinner / skeleton /
//     stream-cursor animate, and those respect prefers-reduced-motion.
//   • Args never render a literal `( )` signature that can wrap awkwardly — they
//     render as a key/value list.
//   • `caused_by` sits on its own right-aligned footer line, like a footer ref.
//
// Pure presentational primitive — no data fetching. The drawer (S2/S3, not this
// lane) feeds it pre-shaped tool-use rows.

'use client';

import { type ReactNode, useState } from 'react';
import type { ChainRowCostMode, ToolUseDetailMode } from '../lib/tweaks';
import { Button } from './Button';
import { Card } from './Card';
import { LoomIcon, type LoomIconName } from './LoomIcon';

/** Lifecycle status a tool_use card can present. */
export type ToolUseStatus = 'running' | 'done' | 'empty' | 'failed' | 'awaiting-approval';

/** Tone tint for proposal-bearing cards. */
export type ToolUseTone = 'coral' | 'info' | 'good';

/** Cost-transparency ribbon. Every field is optional — missing ones drop out. */
export interface ToolUseMeta {
  /** Model label, e.g. `Haiku`, `Sonnet`, `deterministic`. */
  model?: string;
  /** Cost in USD. `0` renders the deterministic `$0.000` chip. */
  cost?: number;
  /** Latency label, e.g. `380ms`, `2.1s`, `streaming`. */
  latency?: string;
  /** Confidence 0..1; rendered as a meter + percentage when present. */
  confidence?: number;
  /** caused_by event id, e.g. `e_4471` — rendered on its own footer line. */
  causedBy?: string;
}

/** A single approval action button (accept / dismiss / retype …). */
export interface ToolUseAction {
  label: string;
  /** Maps to a Button variant; defaults sensibly by `kind`. */
  variant?: 'good' | 'coral' | 'ghost' | 'quiet' | 'danger';
  icon?: LoomIconName;
  /** `accept` keeps the result; `dismiss` dims the card. */
  kind: 'accept' | 'dismiss';
  /** Event id + verb shown on the resolved line, e.g. `e_4491 · propose→accept`. */
  ev?: string;
  /** Resolved-line copy after the action fires. */
  done: string;
}

/** Resolved state — set when an approval action has fired (controlled or self). */
export interface ToolUseResolved {
  kind: 'accept' | 'dismiss';
  text: string;
  ev?: string;
}

export interface ToolUseCardProps {
  /** Tool identifier, e.g. `query_mistakes`. */
  toolName: string;
  /** Concise summary (≤120 chars). Maps to DomainTool.summarize() output. */
  summary?: string;
  /** Tokens or $ chip; rendered next to the head. */
  costLabel?: string;
  /** Optional structured detail (e.g. cost in micro-USD). Rendered in second row when chainRowCost ≠ 'summary-only'. */
  costDetail?: string;
  /** Free-form expanded body (markdown already-rendered, or table). */
  body?: ReactNode;
  /** Initial expand state when uncontrolled. */
  defaultExpanded?: boolean;
  /** Controlled expand state. */
  expanded?: boolean;
  /** Controlled onChange handler. */
  onExpandedChange?: (next: boolean) => void;
  /** Drawer-level chainRowCost tweak — controls cost detail row visibility. */
  chainRowCost?: ChainRowCostMode;
  /**
   * Detail render mode override. Most callers should just let the drawer
   * decide via the tweaks panel. 'off' hides the entire card body and
   * expand affordance (head + cost only).
   */
  detailMode?: ToolUseDetailMode;

  /* ── full-anatomy additions (S1) — all optional, backward compatible ── */
  /** Lifecycle status. When set, renders a status pill + state-specific result. */
  status?: ToolUseStatus;
  /** Tone tint for proposal-bearing cards (coral / info / good). */
  tone?: ToolUseTone;
  /** Header icon (loom icon name). Defaults to a copilot spark when omitted. */
  icon?: LoomIconName;
  /** Actor label shown in the header, default `agent`. Pass `null` to hide. */
  actor?: string | null;
  /** Call arguments — rendered as a key/value list + collapsible raw JSON. */
  args?: Record<string, unknown>;
  /** Done-state structured result body. */
  result?: ReactNode;
  /** Running-state body (skeleton / stream). Falls back to a shimmer skeleton. */
  running?: ReactNode;
  /** Empty-state body (gentle). */
  emptyView?: ReactNode;
  /** Failed-state body (error + retry hint). */
  errorView?: ReactNode;
  /** Cost-transparency ribbon. */
  meta?: ToolUseMeta;
  /** Approval actions — shown only in `awaiting-approval` state. */
  actions?: ToolUseAction[];
  /** Hint copy on the left of the action row. */
  actionHint?: string;
  /** Controlled resolved state. When set, the resolved line shows + actions hide. */
  resolved?: ToolUseResolved | null;
  /** Fired when an (uncontrolled) approval action resolves the card. */
  onResolve?: (resolved: ToolUseResolved) => void;
}

const STATUS_PILL: Record<
  ToolUseStatus,
  { cls: string; icon: LoomIconName; label: string; spin?: boolean }
> = {
  running: { cls: 'is-running', icon: 'refresh', label: '运行中', spin: true },
  done: { cls: 'is-done', icon: 'check', label: '完成' },
  empty: { cls: 'is-empty', icon: 'minus', label: '无结果' },
  failed: { cls: 'is-failed', icon: 'alert', label: '失败' },
  'awaiting-approval': { cls: 'is-waiting', icon: 'clock', label: '待你批准' },
};

const ACTION_VARIANT: Record<ToolUseAction['kind'], 'good' | 'quiet'> = {
  accept: 'good',
  dismiss: 'quiet',
};

function StatusPill({ status }: { status: ToolUseStatus }) {
  const s = STATUS_PILL[status];
  return (
    <span className={`tuc-pill ${s.cls}`} data-testid="tool-use-status-pill">
      <LoomIcon name={s.icon} size={13} className={s.spin ? 'spin' : ''} />
      {s.label}
    </span>
  );
}

function ConfidenceMeter({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const level = value >= 0.8 ? 'high' : value >= 0.6 ? 'mid' : 'low';
  return (
    <span className="tuc-conf" title={`confidence ${pct}%`}>
      <span className="tuc-conf-bar">
        <i className={level} style={{ width: `${pct}%` }} />
      </span>
      <span className="tuc-conf-pct">{pct}%</span>
    </span>
  );
}

function formatCost(cost: number): string {
  if (cost === 0) return '$0.000';
  return `$${cost.toFixed(cost < 0.01 ? 4 : 3)}`;
}

/** args key/value list + collapsible raw JSON. */
function ArgsBlock({ args }: { args: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  const keys = Object.keys(args);
  if (keys.length === 0) return null;

  const valueClass = (v: unknown) =>
    typeof v === 'number' ? 'is-num' : typeof v === 'string' ? 'is-str' : '';
  // Valid JSON for the "raw json" view — handles nested objects/arrays and
  // escapes strings (quotes / backslashes / newlines) that hand-assembly broke.
  const raw = JSON.stringify(args, null, 2);

  return (
    <div className="tuc-args" data-testid="tool-use-args">
      <div className="tuc-args-sig">
        <span className="tuc-args-label">arguments</span>
        <button
          type="button"
          className={`tuc-args-toggle${open ? ' is-open' : ''}`}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          data-testid="tool-use-args-toggle"
        >
          {open ? '收起' : 'raw json'} <LoomIcon name="arrow" size={12} />
        </button>
      </div>
      {open ? (
        <pre className="tuc-args-raw" data-testid="tool-use-args-raw">
          {raw}
        </pre>
      ) : (
        <div className="tuc-args-list" data-testid="tool-use-args-list">
          {keys.map((k) => (
            <div className="tuc-args-row" key={k}>
              <span className="tuc-args-k">{k}</span>
              <span className={`tuc-args-v ${valueClass(args[k])}`}>{String(args[k])}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** model · $cost · latency · confidence · caused_by ribbon. */
function MetaRibbon({ meta }: { meta: ToolUseMeta }) {
  const hasModel = meta.model != null;
  const hasCost = meta.cost != null;
  const hasLatency = meta.latency != null;
  const hasConf = meta.confidence != null;
  // Nothing inline and no caused_by → render nothing at all.
  if (!hasModel && !hasCost && !hasLatency && !hasConf && meta.causedBy == null) return null;

  const inline: ReactNode[] = [];
  if (hasModel) inline.push(<span className="tuc-meta-model">{meta.model}</span>);
  if (hasCost) {
    const free = meta.cost === 0;
    inline.push(
      <span className={`tuc-meta-cost${free ? ' is-free' : ''}`}>
        {formatCost(meta.cost as number)}
      </span>,
    );
  }
  if (hasLatency) inline.push(<span className="tuc-meta-lat">{meta.latency}</span>);
  if (hasConf) inline.push(<ConfidenceMeter value={meta.confidence as number} />);

  return (
    <div className="tuc-meta" data-testid="tool-use-meta">
      {inline.map((node, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional dot-separated ribbon segments, order is stable
        <span className="tuc-meta-seg" key={i}>
          {i > 0 ? <span className="tuc-meta-dot">·</span> : null}
          {node}
        </span>
      ))}
      {meta.causedBy != null ? (
        <span className="tuc-meta-caused" data-testid="tool-use-caused-by">
          <b>caused_by</b> {meta.causedBy}
        </span>
      ) : null}
    </div>
  );
}

function ResultSkeleton() {
  return (
    <div className="tuc-skel" aria-hidden="true">
      <div className="tuc-skel-ln" style={{ width: '92%' }} />
      <div className="tuc-skel-ln" style={{ width: '70%' }} />
      <div className="tuc-skel-ln" style={{ width: '80%' }} />
    </div>
  );
}

export function ToolUseCard({
  toolName,
  summary,
  costLabel,
  costDetail,
  body,
  defaultExpanded = false,
  expanded: expandedProp,
  onExpandedChange,
  chainRowCost = 'summary-only',
  detailMode = 'folded',
  status,
  tone,
  icon,
  actor = 'agent',
  args,
  result,
  running,
  emptyView,
  errorView,
  meta,
  actions,
  actionHint,
  resolved: resolvedProp,
  onResolve,
}: ToolUseCardProps) {
  const controlled = expandedProp !== undefined;
  const [uncontrolled, setUncontrolled] = useState(defaultExpanded);
  const expanded = controlled ? Boolean(expandedProp) : uncontrolled;

  // Resolved state — controlled via `resolved` prop, else self-managed.
  const resolvedControlled = resolvedProp !== undefined;
  const [selfResolved, setSelfResolved] = useState<ToolUseResolved | null>(null);
  const resolved = resolvedControlled ? resolvedProp : selfResolved;

  function toggle() {
    const next = !expanded;
    if (controlled) {
      onExpandedChange?.(next);
    } else {
      setUncontrolled(next);
      onExpandedChange?.(next);
    }
  }

  function fireAction(action: ToolUseAction) {
    const next: ToolUseResolved = { kind: action.kind, text: action.done, ev: action.ev };
    if (!resolvedControlled) setSelfResolved(next);
    onResolve?.(next);
  }

  // Cost-detail row visibility derives from the chainRowCost tweak.
  const showCostRow = chainRowCost !== 'summary-only' && Boolean(costDetail);
  const costRowClassName =
    chainRowCost === 'always-show'
      ? 'block text-[11px] text-[var(--ink-3)] mt-[4px]'
      : 'hidden text-[11px] text-[var(--ink-3)] mt-[4px] group-hover:block';

  const allowExpand = detailMode !== 'off';
  const bodyVisible = expanded && allowExpand && body !== undefined;

  // ── full-anatomy mode is active when any rich prop is supplied ──
  const isRich =
    status !== undefined ||
    args !== undefined ||
    result !== undefined ||
    meta !== undefined ||
    tone !== undefined ||
    icon !== undefined ||
    actionHint !== undefined ||
    resolvedProp != null ||
    (actions !== undefined && actions.length > 0);

  // State-specific result content (rich mode only).
  function renderResult(): ReactNode {
    switch (status) {
      case 'running':
        return running ?? <ResultSkeleton />;
      case 'empty':
        return emptyView ?? null;
      case 'failed':
        return errorView ?? null;
      default:
        // done / awaiting-approval / undefined → structured result, falling
        // back to the legacy `body` (header contract) when no `result` given.
        return result ?? body ?? null;
    }
  }

  const resultNode = isRich ? renderResult() : null;
  const hasResultBody = isRich && resultNode != null && resultNode !== false;
  // Ribbon is hidden for empty/failed states (cost-noise on a non-result).
  const showMeta = isRich && meta !== undefined && status !== 'empty' && status !== 'failed';
  const showActions =
    isRich &&
    status === 'awaiting-approval' &&
    actions !== undefined &&
    actions.length > 0 &&
    !resolved;

  const toneClass = tone ? ` tone-${tone}` : '';
  const resolvedClass = resolved
    ? resolved.kind === 'dismiss'
      ? ' is-dismissed'
      : ' is-resolved'
    : '';

  return (
    <Card
      data-testid="tool-use-card"
      data-tool={toolName}
      data-expanded={bodyVisible ? 'true' : 'false'}
      data-status={status ?? undefined}
      className={`group tool-use-card${isRich ? ' is-rich' : ''}${toneClass}${resolvedClass}`}
    >
      {/* ── header ── */}
      <div className="tuc-head">
        {isRich ? (
          <span className="tuc-head-ico" aria-hidden="true">
            <LoomIcon name={icon ?? 'copilot'} size={16} />
          </span>
        ) : null}
        <span className="tuc-name font-mono text-[var(--ink-2)] shrink-0">{toolName}</span>
        {summary ? (
          <span className="tuc-summary text-[var(--ink-3)] truncate">{summary}</span>
        ) : null}
        {isRich && actor ? (
          <span className="tuc-actor">
            <LoomIcon name="copilot" size={11} /> {actor}
          </span>
        ) : null}
        <span className="tuc-head-end ml-auto flex items-center gap-[6px]">
          {costLabel ? (
            <span className="text-[11px] text-[var(--ink-3)] tabular-nums">{costLabel}</span>
          ) : null}
          {status !== undefined ? <StatusPill status={status} /> : null}
          {allowExpand && body !== undefined ? (
            <Button
              variant="quiet"
              size="sm"
              aria-expanded={bodyVisible}
              aria-controls={`tool-use-body-${toolName}`}
              onClick={toggle}
              data-testid="tool-use-toggle"
            >
              {bodyVisible ? '收起' : '展开'}
            </Button>
          ) : null}
        </span>
      </div>

      {/* ── args ── */}
      {isRich && args !== undefined ? <ArgsBlock args={args} /> : null}

      {/* ── cost-detail row (legacy chainRowCost tweak) ── */}
      {showCostRow ? (
        <div data-testid="tool-use-cost-row" className={costRowClassName}>
          {costDetail}
        </div>
      ) : null}

      {/* ── result (rich, state-specific) ── */}
      {hasResultBody ? (
        <div className="tuc-result" data-testid="tool-use-result">
          {resultNode}
        </div>
      ) : null}

      {/* ── result (legacy folded body) ── */}
      {bodyVisible ? (
        <div
          id={`tool-use-body-${toolName}`}
          data-testid="tool-use-body"
          className="mt-[8px] text-[13px] leading-[1.55] text-[var(--ink)]"
        >
          {body}
        </div>
      ) : null}

      {/* ── meta ribbon ── */}
      {showMeta ? <MetaRibbon meta={meta as ToolUseMeta} /> : null}

      {/* ── actions (approval) ── */}
      {showActions ? (
        <div className="tuc-actions" data-testid="tool-use-actions">
          <span className="tuc-actions-hint">{actionHint ?? '你来定夺'}</span>
          {(actions as ToolUseAction[]).map((action) => (
            <Button
              key={`${action.kind}-${action.label}`}
              variant={action.variant ?? ACTION_VARIANT[action.kind]}
              size="sm"
              icon={action.icon}
              onClick={() => fireAction(action)}
            >
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}

      {/* ── resolved line ── */}
      {resolved ? (
        <div
          className={`tuc-resolved${resolved.kind === 'dismiss' ? ' is-dismissed' : ''}`}
          data-testid="tool-use-resolved"
        >
          <LoomIcon name={resolved.kind === 'dismiss' ? 'close' : 'checkCircle'} size={15} />
          <span className="tuc-resolved-text">{resolved.text}</span>
          {resolved.ev ? <span className="tuc-resolved-ev">{resolved.ev}</span> : null}
        </div>
      ) : null}
    </Card>
  );
}
