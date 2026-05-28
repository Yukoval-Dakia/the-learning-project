// Wave 5 / T-D3/A — ToolUseCard 三段式 primitive.
//
// Layout (top to bottom):
//   1) Head row    : tool name + folded summary text + cost chip + expand toggle
//   2) Result body : free-form rendered content (only when expanded)
//   3) Cost row    : optional second-line cost detail (visible per tweaks)
//
// Three sections map to:
//   • head            → always visible
//   • result body     → toggled by `expanded` (controlled or uncontrolled)
//   • cost row        → driven by ChainRowCost tweak
//
// Designed to be a pure presentational primitive — no data fetching. The
// drawer feeds it pre-shaped tool-use rows.

'use client';

import { type ReactNode, useState } from 'react';
import type { ChainRowCostMode, ToolUseDetailMode } from '../lib/tweaks';
import { Button } from './Button';
import { Card } from './Card';

export interface ToolUseCardProps {
  /** Tool identifier, e.g. `query_mistakes`. */
  toolName: string;
  /** Concise summary (≤120 chars). Maps to DomainTool.summarize() output. */
  summary: string;
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
}: ToolUseCardProps) {
  const controlled = expandedProp !== undefined;
  const [uncontrolled, setUncontrolled] = useState(defaultExpanded);
  const expanded = controlled ? Boolean(expandedProp) : uncontrolled;

  function toggle() {
    const next = !expanded;
    if (controlled) {
      onExpandedChange?.(next);
    } else {
      setUncontrolled(next);
      onExpandedChange?.(next);
    }
  }

  // Cost-detail row visibility derives from the chainRowCost tweak.
  //   summary-only  → never show; cost lives on head chip only
  //   hover-on-row  → show on hover (we render but hide via group-hover)
  //   always-show   → show statically
  const showCostRow = chainRowCost !== 'summary-only' && Boolean(costDetail);
  const costRowClassName =
    chainRowCost === 'always-show'
      ? 'block text-[11px] text-[var(--ink-3)] mt-[4px]'
      : 'hidden text-[11px] text-[var(--ink-3)] mt-[4px] group-hover:block';

  const allowExpand = detailMode !== 'off';
  const bodyVisible = expanded && allowExpand && body !== undefined;

  return (
    <Card
      data-testid="tool-use-card"
      data-tool={toolName}
      data-expanded={bodyVisible ? 'true' : 'false'}
      className="group"
    >
      <div className="flex items-center gap-[8px] text-[12.5px] leading-[1.4]">
        <span className="font-mono text-[var(--ink-2)] shrink-0">{toolName}</span>
        <span className="text-[var(--ink-3)] truncate">{summary}</span>
        <span className="ml-auto flex items-center gap-[6px]">
          {costLabel ? (
            <span className="text-[11px] text-[var(--ink-3)] tabular-nums">{costLabel}</span>
          ) : null}
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
      {showCostRow ? (
        <div data-testid="tool-use-cost-row" className={costRowClassName}>
          {costDetail}
        </div>
      ) : null}
      {bodyVisible ? (
        <div
          id={`tool-use-body-${toolName}`}
          data-testid="tool-use-body"
          className="mt-[8px] text-[13px] leading-[1.55] text-[var(--ink)]"
        >
          {body}
        </div>
      ) : null}
    </Card>
  );
}
