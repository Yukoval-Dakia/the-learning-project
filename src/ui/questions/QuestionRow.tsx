// YUK-288 题库 UI — one row of the question list. Mirrors screen-questions.jsx
// QRow (rail glyph + stem preview + knowledge chips + difficulty pips + kind /
// source / time aside). Read-only (S1): the row is a Link to the detail route.

import { LoomIcon } from '@/ui/primitives/LoomIcon';
import Link from 'next/link';
import type { ReactElement } from 'react';
import { QMarkdown } from './QMarkdown';
import { difficultyMeta, groundingTierMeta, kindMeta, lineageGlyph, sourceMeta } from './meta';
import type { QuestionListItem } from './types';

function DiffPips({ d }: { d: number }): ReactElement {
  const meta = difficultyMeta(d);
  return (
    <span className="qb-diff" title={`难度 ${d} · ${meta.word}`}>
      <span className="qb-diff-pips">
        {[1, 2, 3, 4, 5].map((i) => (
          <span key={i} className={`qb-pip${i <= d ? ` on tone-${meta.tone}` : ''}`} />
        ))}
      </span>
      <span className="qb-diff-l">{meta.word}</span>
    </span>
  );
}

export interface QuestionRowProps {
  item: QuestionListItem;
  // resolve a knowledge id → display name (falls back to the id when unknown).
  labelFor: (knowledgeId: string) => string;
  // notation for the题面 preview (subject render model — defaults to no-latex).
  notation?: 'latex' | 'wenyan' | 'plaintext' | 'code';
  formatTime: (sec: number) => string;
}

export function QuestionRow({
  item,
  labelFor,
  notation,
  formatTime,
}: QuestionRowProps): ReactElement {
  const kind = kindMeta(item.kind);
  const source = sourceMeta(item.source);
  const lineage = lineageGlyph(item);
  const tier = groundingTierMeta(item.source_tier.tier);
  return (
    <Link href={`/questions/${item.id}`} className="qb-row">
      <div className="qb-rail">
        <span className={`qb-glyph ${lineage.cls}`} title={lineage.title}>
          {lineage.glyph}
        </span>
      </div>

      <div className="qb-main">
        <div className="qb-stem">
          <QMarkdown text={item.prompt_md} notation={notation} />
        </div>
        <div className="qb-tags">
          {item.knowledge_ids.map((k) => (
            <span key={k} className="qb-ktag">
              <LoomIcon name="tag" size={11} />
              {labelFor(k)}
            </span>
          ))}
          <span style={{ flex: 1 }} />
          {/* grounding tier micro-indicator (derived provenance; secondary to source). */}
          <span className={`qb-ind tone-${tier.tone}`} title="来源可信度（派生 grounding tier）">
            <LoomIcon name="target" size={12} />
            {tier.label}
          </span>
        </div>
      </div>

      <div className="qb-aside">
        <span className="qb-kind">
          <LoomIcon name={kind.icon} size={13} />
          {kind.label}
        </span>
        <DiffPips d={item.difficulty} />
        <span className={`qb-source tone-${source.tone}`}>
          <LoomIcon name={source.icon} size={13} />
          {source.label}
        </span>
        <span className="qb-time">
          {item.draft_status === 'draft' && (
            <span className="qb-draftdot" style={{ marginRight: 4 }} />
          )}
          {formatTime(item.created_at_sec)}
        </span>
      </div>
    </Link>
  );
}
