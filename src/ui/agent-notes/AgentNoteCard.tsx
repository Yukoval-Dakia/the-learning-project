// One agent-note card — rail (avatar over a connecting thread), route line
// (source → target(s) · signal chip), body (light inline md), meta row
// (confidence · time · evidence · ttl). Reused verbatim by the Today compact
// block and the full-screen view. Read-only: the only interactive element is the
// evidence link (router.push to the events chain). No accept/dismiss.

import { formatRelTime } from '@/ui/lib/utils';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { Fragment } from 'react';
import { anInlineMd, deriveTtl, resolveEvidence } from './derive';
import { agentMeta, signalMeta } from './meta';
import type { BoardAgentNote } from './types';

export interface AgentNoteCardProps {
  note: BoardAgentNote;
  unread: boolean;
  now: Date;
  onNavigate: (route: string) => void;
}

export function AgentNoteCard({ note, unread, now, onNavigate }: AgentNoteCardProps) {
  const sig = signalMeta(note.signal_kind);
  const from = agentMeta(note.source_task_kind);
  const tos = note.target_agents.map((id) => ({ id, meta: agentMeta(id) }));
  const ttl = deriveTtl(note.expires_at, now);
  const evidence = resolveEvidence(note);

  return (
    <div className="an-note" data-unread={unread ? '1' : '0'}>
      <div className="an-rail">
        <span className={`an-avatar tone-${sig.tone}`} title={from.label}>
          <LoomIcon name={from.icon} size={16} />
        </span>
      </div>
      <div className="an-main">
        <div className="an-route">
          <span className="an-ag an-from">
            <LoomIcon name={from.icon} size={13} />
            {from.label}
          </span>
          <LoomIcon name="arrow" size={13} className="an-flow" />
          <span className="an-ag an-to">
            {tos.map((t, i) => (
              <Fragment key={t.id}>
                {i > 0 && <span className="an-to-sep">·</span>}
                <LoomIcon name={t.meta.icon} size={13} />
                {t.meta.label}
              </Fragment>
            ))}
          </span>
          {unread && <span className="an-new">新</span>}
          <span className={`an-sig tone-chip-${sig.tone}`}>{sig.label}</span>
        </div>

        <div className="an-body">{anInlineMd(note.summary_md)}</div>

        <div className="an-meta">
          {note.confidence != null && (
            <span className="an-conf">
              <LoomIcon name="sparkle" size={11} />
              置信 {Math.round(note.confidence * 100)}%
            </span>
          )}
          <span className="an-time">{formatRelTime(note.created_at, now)}</span>
          {evidence &&
            (evidence.href ? (
              <button
                type="button"
                className="an-evi"
                onClick={() => onNavigate(evidence.href as string)}
              >
                <LoomIcon name="link" size={12} />
                {evidence.label} →
              </button>
            ) : (
              <span className="an-evi-static">
                <LoomIcon name="link" size={12} />
                {evidence.label}
              </span>
            ))}
          {ttl &&
            (ttl.soon ? (
              <span className="an-expire">
                <LoomIcon name="clock" size={11} />
                临期 · {ttl.text}
              </span>
            ) : (
              <span className="an-ttl">· {ttl.text}</span>
            ))}
        </div>
      </div>
    </div>
  );
}
