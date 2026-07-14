import { formatRelTime } from '@/ui/lib/utils';
import { LoomBadge } from '@/ui/primitives/LoomBadge';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import {
  type AgentNoteGroup,
  agentNoteGroupSummary,
  agentNoteRunLabel,
  deriveTtl,
  resolveEvidence,
} from './derive';
import { agentMeta, signalMeta } from './meta';
import type { BoardAgentNote } from './types';

export interface AgentNoteGroupCardProps {
  group: AgentNoteGroup;
  unread: boolean;
  now: Date;
  onNavigate: (route: string) => void;
}

const RESOLUTION_META = {
  open: { label: '待补充', tone: 'hard' as const },
  resolved: { label: '已有可用内容', tone: 'good' as const },
  unknown: { label: '持续观察', tone: 'neutral' as const },
};

const ATTENTION_META = {
  high: { label: '高关注', tone: 'again' as const },
  medium: { label: '需关注', tone: 'info' as const },
  resolved: { label: '已解决', tone: 'good' as const },
};

function EvidenceButton({
  label,
  href,
  onNavigate,
}: {
  label: string;
  href: string;
  onNavigate: (route: string) => void;
}) {
  return (
    <button type="button" className="an-evi" onClick={() => onNavigate(href)}>
      <LoomIcon name="link" size={12} />
      {label} →
    </button>
  );
}

function AgentNoteRunRow({
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
  const eventHref = note.caused_by_event_id
    ? `/events/${encodeURIComponent(note.caused_by_event_id)}`
    : evidence?.kind === 'event'
      ? evidence.href
      : null;
  const subjectHref = evidence?.href && evidence.href !== eventHref ? evidence.href : null;

  return (
    <li className="an-run-row">
      <span className="an-run-index">{index + 1}</span>
      <span className="an-run-result">{agentNoteRunLabel(note)}</span>
      <span className="meta">{formatRelTime(note.created_at, now)}</span>
      {note.confidence != null && (
        <span className="meta">置信 {Math.round(note.confidence * 100)}%</span>
      )}
      <span className="an-run-links">
        {eventHref && (
          <EvidenceButton label="查看事件证据" href={eventHref} onNavigate={onNavigate} />
        )}
        {subjectHref && evidence && (
          <EvidenceButton
            label={evidence.kind === 'knowledge' ? '查看知识点' : '查看相关内容'}
            href={subjectHref}
            onNavigate={onNavigate}
          />
        )}
      </span>
    </li>
  );
}

export function AgentNoteGroupCard({ group, unread, now, onNavigate }: AgentNoteGroupCardProps) {
  const latest = group.latest;
  const source = agentMeta(latest.source_task_kind);
  const targets = latest.target_agents.map((target) => agentMeta(target));
  const signal = signalMeta(latest.signal_kind);
  const resolution = RESOLUTION_META[group.resolution_state];
  const attention = ATTENTION_META[group.attention];
  const ttl = deriveTtl(group.expires_at, now);
  const title = group.primary_ref?.label ?? signal.label;

  return (
    <article className="an-group-card" data-unread={unread ? '1' : '0'}>
      <div className="an-group-top">
        <span className={`an-avatar tone-${signal.tone}`} title={source.label}>
          <LoomIcon name={source.icon} size={16} />
        </span>
        <span className="an-ag an-from">{source.label}</span>
        <LoomIcon name="arrow" size={13} className="an-flow" />
        <span className="an-ag an-to">
          {targets.map((target) => target.label).join(' · ') || '其他 AI 工作'}
        </span>
        {unread && <span className="an-new">新</span>}
        <span className={`an-sig tone-chip-${signal.tone}`}>{signal.label}</span>
      </div>

      <div className="an-group-heading">
        <div>
          <h3 className="an-group-title">{title}</h3>
          <p className="an-body">{agentNoteGroupSummary(group)}</p>
        </div>
        <div className="an-group-states">
          <LoomBadge tone={attention.tone}>{attention.label}</LoomBadge>
          <LoomBadge tone={resolution.tone}>{resolution.label}</LoomBadge>
        </div>
      </div>

      <div className="an-meta">
        <span>{group.run_count} 次运行</span>
        {group.notes.length !== group.run_count && <span>{group.notes.length} 条记录</span>}
        <span>最新 {formatRelTime(latest.created_at, now)}</span>
        {ttl &&
          (ttl.soon ? (
            <span className="an-expire">
              <LoomIcon name="clock" size={11} />
              {ttl.text}
            </span>
          ) : (
            <span className="an-ttl">· {ttl.text}</span>
          ))}
      </div>

      <details className="an-group-runs">
        <summary>
          {group.run_count === 1 ? '查看本次运行与证据' : `查看 ${group.run_count} 次运行与证据`}
        </summary>
        <ol>
          {group.notes.map((note, index) => (
            <AgentNoteRunRow
              key={note.id}
              note={note}
              index={index}
              now={now}
              onNavigate={onNavigate}
            />
          ))}
        </ol>
      </details>
    </article>
  );
}
