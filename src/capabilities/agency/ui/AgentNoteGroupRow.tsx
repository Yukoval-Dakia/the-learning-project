// One grouped observation, M3E presentation (YUK-1473): the full /agent-notes page and, since
// YUK-1713, the Today board (AgentNotesBoard), which replaced the old AgentNoteGroupCard (same
// data, derivations and links). Read-only: the only actions are evidence links. Styles in
// agent-notes-m3e.css; design records docs/design/2026-11-03-inbox-agent-notes-events-m3e.md and
// docs/design/2026-11-03-today-finish-m3e.md.

import { ArrowRight, ChevronDown, Clock, Link2 } from 'lucide-react';
import { formatRelTime } from '@/ui/lib/utils';
import {
  type AgentNoteGroup,
  type EvidenceRef,
  type TtlInfo,
  agentNoteGroupSummary,
  agentNoteRunLabel,
  deriveTtl,
  resolveEvidence,
} from './derive';
import { agentMeta, signalMeta } from './meta';
import type { BoardAgentNote } from './types';

/** Signal tone → ui-next tone role (hard → caution, info → accent, good → positive, coral → secondary). */
const SIGNAL_TONE: Record<string, string> = {
  hard: 'caution',
  info: 'accent',
  good: 'positive',
  coral: 'secondary',
  neutral: 'neutral',
};

export function signalToneRole(tone: string): string {
  return SIGNAL_TONE[tone] ?? 'neutral';
}

const RESOLUTION_META = {
  open: { label: '待补充', tone: 'caution' },
  resolved: { label: '已有可用内容', tone: 'positive' },
  unknown: { label: '持续观察', tone: 'neutral' },
} as const;

const ATTENTION_META = {
  high: { label: '高关注', tone: 'critical' },
  medium: { label: '需关注', tone: 'accent' },
  resolved: { label: '已解决', tone: 'positive' },
} as const;

// The event behind one run: its own causing event first, else event evidence (early returns
// instead of a chained ternary).
function runEventHref(note: BoardAgentNote, evidence: EvidenceRef | null): string | null {
  if (note.caused_by_event_id) return `/events/${encodeURIComponent(note.caused_by_event_id)}`;
  if (evidence?.kind === 'event') return evidence.href;
  return null;
}

function EvidenceLink({
  label,
  href,
  onNavigate,
}: {
  label: string;
  href: string;
  onNavigate: (route: string) => void;
}) {
  return (
    <button type="button" className="ag-evi un-hit" onClick={() => onNavigate(href)}>
      <Link2 size={12} aria-hidden="true" />
      {label}
      <ArrowRight size={12} aria-hidden="true" />
    </button>
  );
}

function RunRow({
  note,
  index,
  now,
  onNavigate,
}: {
  note: BoardAgentNote;
  index: number;
  now: Date;
  onNavigate: (route: string) => void;
}) {
  const evidence = resolveEvidence(note);
  const eventHref = runEventHref(note, evidence);
  const subjectHref = evidence?.href && evidence.href !== eventHref ? evidence.href : null;

  return (
    <li className="ag-run">
      <span className="ag-run-index un-num">{index + 1}</span>
      <span className="ag-run-result">{agentNoteRunLabel(note)}</span>
      <span className="ag-quiet">{formatRelTime(note.created_at, now)}</span>
      {note.confidence != null && (
        <span className="ag-quiet un-num">置信 {Math.round(note.confidence * 100)}%</span>
      )}
      <span className="ag-run-links">
        {eventHref && (
          <EvidenceLink label="查看事件证据" href={eventHref} onNavigate={onNavigate} />
        )}
        {subjectHref && evidence && (
          <EvidenceLink
            label={evidence.kind === 'knowledge' ? '查看知识点' : '查看相关内容'}
            href={subjectHref}
            onNavigate={onNavigate}
          />
        )}
      </span>
    </li>
  );
}

function TtlLine({ ttl }: { ttl: TtlInfo }) {
  if (ttl.soon) {
    return (
      <span className="ag-expire">
        <Clock size={11} aria-hidden="true" />
        {ttl.text}
      </span>
    );
  }
  return <span>· {ttl.text}</span>;
}

export interface AgentNoteGroupRowProps {
  group: AgentNoteGroup;
  unread: boolean;
  now: Date;
  onNavigate: (route: string) => void;
}

export function AgentNoteGroupRow({ group, unread, now, onNavigate }: AgentNoteGroupRowProps) {
  const latest = group.latest;
  const source = agentMeta(latest.source_task_kind);
  const targets = latest.target_agents.map((target) => agentMeta(target));
  const signal = signalMeta(latest.signal_kind);
  const resolution = RESOLUTION_META[group.resolution_state];
  const attention = ATTENTION_META[group.attention];
  const ttl = deriveTtl(group.expires_at, now);
  const title = group.primary_ref?.label ?? signal.label;
  const SourceIcon = source.icon;
  const tone = signalToneRole(signal.tone);

  return (
    <article className="ag-group" data-unread={unread ? '1' : '0'}>
      <span className="ag-avatar" data-tone={tone} title={source.label} aria-hidden="true">
        <SourceIcon size={16} />
      </span>
      <div className="ag-group-body">
        <div className="ag-route">
          <span className="ag-from">{source.label}</span>
          <ArrowRight size={13} aria-hidden="true" className="ag-flow" />
          <span>{targets.map((target) => target.label).join(' · ') || '其他 AI 工作'}</span>
          {unread && <span className="ag-new">新</span>}
          <span className="ag-tag ag-route-sig" data-tone={tone}>
            {signal.label}
          </span>
        </div>

        <div className="ag-heading">
          <div className="ag-heading-text">
            <h3 className="ag-group-title">{title}</h3>
            <p className="ag-summary">{agentNoteGroupSummary(group)}</p>
          </div>
          <div className="ag-states">
            <span className="ag-tag" data-tone={attention.tone}>
              {attention.label}
            </span>
            <span className="ag-tag" data-tone={resolution.tone}>
              {resolution.label}
            </span>
          </div>
        </div>

        <div className="ag-meta">
          <span>{group.run_count} 次运行</span>
          {group.notes.length !== group.run_count && <span>{group.notes.length} 条记录</span>}
          <span>最新 {formatRelTime(latest.created_at, now)}</span>
          {ttl && <TtlLine ttl={ttl} />}
        </div>

        <details className="ag-runs">
          <summary className="un-hit">
            {group.run_count === 1 ? '查看本次运行与证据' : `查看 ${group.run_count} 次运行与证据`}
            <ChevronDown size={14} aria-hidden="true" className="ag-runs-chev" />
          </summary>
          <ol className="ag-run-list">
            {group.notes.map((note, index) => (
              <RunRow key={note.id} note={note} index={index} now={now} onNavigate={onNavigate} />
            ))}
          </ol>
        </details>
      </div>
    </article>
  );
}
