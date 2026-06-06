// YUK-164 OC-5 — auto_enrolled review surface (5th tab on /record).
//
// Self-contained panel: owns its own TanStack Query reads (session list + the
// selected session's blocks + knowledge names), mirroring RecordContextPanel /
// ManualForm which each own their queries. No props threading from RecordPage.
//
// Split (lane plan §3, required for testability): the data-fetching `AutoEnrolledPanel`
// container is thin; ALL markup lives in the pure presentational `PanelBody`, which
// takes already-resolved props (no useQuery / useMutation). Only `PanelBody` is
// renderToString'd in the slice-2 component test; the live wiring is not unit-tested
// on the node-only stack (the revert SERVICE path is covered by revert-auto-enroll.test.ts).
//
// Minimal-functional ONLY — visual polish belongs to redraw-wave2 (redraw-brief:42).
// Wired with existing primitives + 4pt-grid tokens; no bespoke visuals.

'use client';

import { ApiAuthError, ApiError, apiJson } from '@/ui/lib/api';
import {
  type AutoEnrollObservation,
  formatConfidence,
  isRevertable,
  shouldShowObserveBanner,
} from '@/ui/lib/auto-enroll';
import { Badge } from '@/ui/primitives/Badge';
import { Btn } from '@/ui/primitives/Btn';
import { Card } from '@/ui/primitives/Card';
import { EmptyState } from '@/ui/primitives/EmptyState';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { SectionLabel } from '@/ui/primitives/SectionLabel';
import { SkLines } from '@/ui/primitives/SkLines';
import { Stateful } from '@/ui/primitives/Stateful';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

// ---------------------------------------------------------------------------
// Wire shapes (reads only — see app/api/ingestion route + blocks route)
// ---------------------------------------------------------------------------

interface IngestionSessionRow {
  id: string;
  entrypoint: string | null;
  status: string;
  source_asset_ids: string[];
  observation_count: number;
  auto_enrolled_count: number;
  block_count: number;
  created_at: number;
}

interface BlockRow {
  id: string;
  status: 'draft' | 'imported' | 'ignored' | 'auto_enrolled';
  knowledge_hint: string | null;
  auto_enroll_observation: AutoEnrollObservation | null;
  created_at: number;
}

interface KnowledgeNode {
  id: string;
  name: string;
  effective_domain: string | null;
}

/** A row in the panel: a block that carries an observation (filtered upstream). */
export interface ObservedRow {
  blockId: string;
  status: BlockRow['status'];
  observation: AutoEnrollObservation;
}

// ---------------------------------------------------------------------------
// Container — owns the queries, resolves them, hands resolved props to PanelBody.
// ---------------------------------------------------------------------------

export function AutoEnrolledPanel() {
  const qc = useQueryClient();
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  // Per-row two-step revert confirm: which blockId is awaiting confirmation.
  const [confirmingBlockId, setConfirmingBlockId] = useState<string | null>(null);

  const sessionsQ = useQuery({
    queryKey: ['ingestion-sessions'],
    queryFn: () => apiJson<{ rows: IngestionSessionRow[] }>('/api/ingestion?limit=20'),
  });

  // Default the selection to the most-recent session once the list loads.
  useEffect(() => {
    const rows = sessionsQ.data?.rows ?? [];
    if (rows.length === 0) return;
    if (selectedSessionId && rows.some((r) => r.id === selectedSessionId)) return;
    setSelectedSessionId(rows[0].id);
  }, [sessionsQ.data, selectedSessionId]);

  // Reuse the EXACT query key VisionTab uses so revert here + import there share
  // cache-invalidation semantics (VisionTab.tsx:151).
  const blocksQ = useQuery({
    queryKey: ['ingestion-blocks', selectedSessionId],
    queryFn: () => apiJson<{ rows: BlockRow[] }>(`/api/ingestion/${selectedSessionId}/blocks`),
    enabled: !!selectedSessionId,
  });

  const knowledgeQ = useQuery({
    queryKey: ['knowledge'],
    queryFn: () => apiJson<{ rows: KnowledgeNode[] }>('/api/knowledge'),
  });

  const knowledgeNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of knowledgeQ.data?.rows ?? []) m.set(n.id, n.name);
    return m;
  }, [knowledgeQ.data]);

  const revertM = useMutation({
    mutationFn: (blockId: string) =>
      apiJson(`/api/ingestion/${selectedSessionId}/revert`, {
        method: 'POST',
        body: JSON.stringify({ block_id: blockId }),
      }),
    onSuccess: () => {
      setConfirmingBlockId(null);
      // Refetch (not optimistic) — revert touches multiple tables; the block flips
      // to draft, its observation row stays but loses the revert affordance.
      qc.invalidateQueries({ queryKey: ['ingestion-blocks', selectedSessionId] });
      qc.invalidateQueries({ queryKey: ['ingestion-sessions'] });
    },
  });

  const blocks = blocksQ.data?.rows ?? [];
  const observedRows: ObservedRow[] = useMemo(
    () =>
      blocks
        .filter((b) => b.auto_enroll_observation !== null)
        .map((b) => ({
          blockId: b.id,
          status: b.status,
          // non-null asserted by the filter above
          observation: b.auto_enroll_observation as AutoEnrollObservation,
        })),
    [blocks],
  );

  // Banner derives from the loaded blocks — the SAME source as the per-row revert
  // gate (lane plan §3 P2-3) — never from the session-list count.
  const showBanner = shouldShowObserveBanner(blocks);

  const sessions = sessionsQ.data?.rows ?? [];

  const status: 'loading' | 'error' | 'empty' | 'ok' =
    sessionsQ.isLoading || (!!selectedSessionId && blocksQ.isLoading)
      ? 'loading'
      : sessionsQ.isError || blocksQ.isError
        ? 'error'
        : observedRows.length === 0
          ? 'empty'
          : 'ok';

  const errorText = formatLoadError(sessionsQ.error ?? blocksQ.error);

  const onRetry = () => {
    if (sessionsQ.isError) sessionsQ.refetch();
    if (blocksQ.isError) blocksQ.refetch();
  };

  return (
    <div style={panelWrapStyle}>
      <PanelHeader />

      {sessions.length > 1 && (
        <SessionPicker
          sessions={sessions}
          selectedId={selectedSessionId}
          onSelect={(id) => {
            setSelectedSessionId(id);
            setConfirmingBlockId(null);
          }}
        />
      )}

      <Stateful
        status={status}
        skeleton={<SkLines rows={3} />}
        errorText={errorText}
        onRetry={onRetry}
        empty={
          <EmptyState
            icon="eye"
            title="AI 正在观察，尚未自动录入"
            text="开启 auto-enroll 后，AI 拟录入的错题 / 记录会列在这里，每项可一键撤销。"
          />
        }
      >
        <PanelBody
          observedRows={observedRows}
          showBanner={showBanner}
          knowledgeNameById={knowledgeNameById}
          confirmingBlockId={confirmingBlockId}
          reverting={revertM.isPending}
          revertErrorText={revertM.isError ? formatLoadError(revertM.error) : null}
          onRevertClick={(blockId) => setConfirmingBlockId(blockId)}
          onRevertConfirm={(blockId) => revertM.mutate(blockId)}
          onRevertCancel={() => setConfirmingBlockId(null)}
        />
      </Stateful>
    </div>
  );
}

function formatLoadError(err: unknown): string {
  if (err instanceof ApiAuthError) return `${err.message} — 请重新进入页面输入 token`;
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return '无法读取自动录入项。';
}

// ---------------------------------------------------------------------------
// Presentational — PURE. Takes resolved props only; no queries. renderToString-able.
// ---------------------------------------------------------------------------

interface PanelBodyProps {
  observedRows: ObservedRow[];
  showBanner: boolean;
  knowledgeNameById: Map<string, string>;
  confirmingBlockId: string | null;
  reverting: boolean;
  revertErrorText: string | null;
  onRevertClick: (blockId: string) => void;
  onRevertConfirm: (blockId: string) => void;
  onRevertCancel: () => void;
}

export function PanelBody({
  observedRows,
  showBanner,
  knowledgeNameById,
  confirmingBlockId,
  reverting,
  revertErrorText,
  onRevertClick,
  onRevertConfirm,
  onRevertCancel,
}: PanelBodyProps) {
  return (
    <div style={bodyStyle} data-testid="auto-enrolled-panel-body">
      {showBanner && <ObserveBanner />}

      <SectionLabel count={`${observedRows.length} 项`}>AI 观察 / 自动录入</SectionLabel>

      <div style={rowListStyle}>
        {observedRows.map((row) => (
          <ObservationRowView
            key={row.blockId}
            row={row}
            knowledgeNameById={knowledgeNameById}
            confirming={confirmingBlockId === row.blockId}
            reverting={reverting}
            revertErrorText={confirmingBlockId === row.blockId ? revertErrorText : null}
            onRevertClick={onRevertClick}
            onRevertConfirm={onRevertConfirm}
            onRevertCancel={onRevertCancel}
          />
        ))}
      </div>
    </div>
  );
}

function PanelHeader() {
  // AI actor attribution → info-blue bolt marker (round2a §1.3 "AI actor 用 info-blue").
  return (
    <div style={headerStyle}>
      <span style={aiMarkerStyle} data-testid="ai-marker">
        <LoomIcon name="bolt" size={15} />
        AI 自动录入 · 复审
      </span>
    </div>
  );
}

function ObserveBanner() {
  // Flag value is not exposed to the browser; the banner is derived from data
  // (no loaded block is auto_enrolled). Text label is the non-color cue.
  return (
    <div style={bannerStyle} data-testid="observe-banner">
      <Badge tone="info">observe-only</Badge>
      <span style={bannerMetaStyle}>
        WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED = OFF · 当前仅观察、块留 draft
      </span>
    </div>
  );
}

interface ObservationRowViewProps {
  row: ObservedRow;
  knowledgeNameById: Map<string, string>;
  confirming: boolean;
  reverting: boolean;
  revertErrorText: string | null;
  onRevertClick: (blockId: string) => void;
  onRevertConfirm: (blockId: string) => void;
  onRevertCancel: () => void;
}

function ObservationRowView({
  row,
  knowledgeNameById,
  confirming,
  reverting,
  revertErrorText,
  onRevertClick,
  onRevertConfirm,
  onRevertCancel,
}: ObservationRowViewProps) {
  const { observation: obs, status, blockId } = row;
  const route = obs.route ?? '—';
  // Route badge: text label IS the non-color cue (auto/review). good vs info tone.
  const routeTone = route === 'auto' ? 'good' : 'info';
  const revertable = isRevertable(row);

  return (
    <Card data-testid="observation-row" data-status={status}>
      <div style={rowHeadStyle}>
        <Badge tone={routeTone}>{route}</Badge>
        <span style={confidenceStyle} data-testid="confidence">
          {formatConfidence(obs.confidence)}
        </span>
        {/* status pill — text label is the non-color cue */}
        <Badge tone={status === 'auto_enrolled' ? 'good' : 'neutral'}>{status}</Badge>
      </div>

      {obs.suggested_knowledge_ids.length > 0 && (
        <div style={chipRowStyle}>
          {obs.suggested_knowledge_ids.map((id) => (
            <span key={id} style={knowledgePillStyle}>
              {knowledgeNameById.get(id) ?? id}
            </span>
          ))}
        </div>
      )}

      {obs.reasoning && (
        <details style={reasoningStyle}>
          <summary style={reasoningSummaryStyle}>AI 路由理由</summary>
          <p style={reasoningTextStyle}>{obs.reasoning}</p>
        </details>
      )}

      <div style={rowActionStyle}>
        {revertable ? (
          confirming ? (
            <span style={confirmGroupStyle}>
              <Btn
                size="sm"
                variant="again"
                icon="undo"
                disabled={reverting}
                onClick={() => onRevertConfirm(blockId)}
              >
                {reverting ? '撤销中…' : '确认撤销'}
              </Btn>
              <Btn size="sm" variant="quiet" onClick={onRevertCancel} disabled={reverting}>
                取消
              </Btn>
            </span>
          ) : (
            <Btn size="sm" variant="ghost" icon="undo" onClick={() => onRevertClick(blockId)}>
              撤销
            </Btn>
          )
        ) : (
          // draft observation row — no actionable revert (would 409). Tell the
          // user why instead of showing a dead button.
          <span style={noRevertHintStyle} data-testid="no-revert-hint">
            仅观察 · 无可撤销项
          </span>
        )}
      </div>

      {revertErrorText && <p style={rowErrorStyle}>{revertErrorText}</p>}
    </Card>
  );
}

interface SessionPickerProps {
  sessions: IngestionSessionRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

function SessionPicker({ sessions, selectedId, onSelect }: SessionPickerProps) {
  return (
    <div style={chipRowStyle} data-testid="session-picker">
      {sessions.map((s) => {
        const active = s.id === selectedId;
        const label = `${s.entrypoint ?? 'ingestion'} · ${formatSessionTime(s.created_at)}`;
        return (
          <button
            type="button"
            key={s.id}
            onClick={() => onSelect(s.id)}
            style={sessionChipStyle(active)}
            // session-list auto_enrolled_count MAY drive only this picker badge —
            // never the banner or per-row affordance (lane plan §3 P2-3).
            title={`${s.observation_count} 观察 · ${s.auto_enrolled_count} 已录入`}
          >
            {label}
            {s.observation_count > 0 && <span style={pickerCountStyle}>{s.observation_count}</span>}
          </button>
        );
      })}
    </div>
  );
}

function formatSessionTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// Styles — 4pt grid tokens only, no hand-written px in spacing/radius.
// ---------------------------------------------------------------------------

const panelWrapStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--s-4)',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--s-2)',
};

const aiMarkerStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--s-1)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  letterSpacing: 'var(--ls-wide)',
  // AI actor = info-blue (round2a §1.3). The token holding #4f6e8e is `--info`.
  color: 'var(--info)',
};

const bodyStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--s-3)',
};

const bannerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--s-2)',
  flexWrap: 'wrap',
};

const bannerMetaStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  color: 'var(--ink-3)',
  letterSpacing: 'var(--ls-wide)',
};

const rowListStyle: React.CSSProperties = {
  display: 'grid',
  gap: 'var(--s-3)',
};

const rowHeadStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--s-2)',
  flexWrap: 'wrap',
};

const confidenceStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  color: 'var(--ink-3)',
  letterSpacing: 'var(--ls-wide)',
};

const chipRowStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'var(--s-1)',
  marginTop: 'var(--s-1)',
};

const knowledgePillStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  padding: '4px 8px',
  borderRadius: 'var(--r-pill)',
  border: '1px solid var(--line-soft)',
  background: 'var(--paper-sunk)',
  color: 'var(--ink-3)',
  overflowWrap: 'anywhere',
};

const reasoningStyle: React.CSSProperties = {
  marginTop: 'var(--s-1)',
};

const reasoningSummaryStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  color: 'var(--ink-4)',
  letterSpacing: 'var(--ls-wide)',
  cursor: 'pointer',
};

const reasoningTextStyle: React.CSSProperties = {
  margin: 'var(--s-1) 0 0',
  fontSize: 'var(--fs-caption)',
  color: 'var(--ink-2)',
  lineHeight: 'var(--lh-prose)',
  whiteSpace: 'pre-wrap',
};

const rowActionStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  alignItems: 'center',
  gap: 'var(--s-2)',
  marginTop: 'var(--s-2)',
};

const confirmGroupStyle: React.CSSProperties = {
  display: 'inline-flex',
  gap: 'var(--s-2)',
};

const noRevertHintStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  color: 'var(--ink-4)',
  letterSpacing: 'var(--ls-wide)',
};

const rowErrorStyle: React.CSSProperties = {
  margin: 'var(--s-2) 0 0',
  fontSize: 'var(--fs-caption)',
  color: 'var(--again-ink)',
};

const sessionChipStyle = (active: boolean): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--s-1)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  padding: '6px 10px',
  borderRadius: 'var(--r-pill)',
  border: `1px solid ${active ? 'var(--coral)' : 'var(--line)'}`,
  background: active ? 'var(--coral-soft)' : 'var(--paper-sunk)',
  color: active ? 'var(--coral-ink)' : 'var(--ink-2)',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  letterSpacing: 'var(--ls-wide)',
});

const pickerCountStyle: React.CSSProperties = {
  fontSize: '10px',
  padding: '0 6px',
  borderRadius: 'var(--r-pill)',
  background: 'var(--info-soft)',
  color: 'var(--info-ink)',
};
