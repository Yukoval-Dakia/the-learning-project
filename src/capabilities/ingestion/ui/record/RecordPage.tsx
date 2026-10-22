// YUK-1473 — 录入 (/record), rebuilt from the learner's goal: hand over material, get its
// questions into the library. One input, one stack of recordings; a recording is one sheet that
// changes in place, and reopening one from the list shows that same sheet. UX note:
// tlp-status/_work/record-rebuild/ux.md.

import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Mascot, UiNextRoot } from '@/ui-next/public';
import { Composer } from './Composer';
import { DraftSheet } from './DraftSheet';
import { HistoryList } from './HistoryList';
import { RecordingSheet } from './RecordingSheet';
import { recordKeys } from './recording-read';
import './record.css';
import './record-lines.css';
import './record-parts.css';
import './record-history.css';

export interface RecordPageProps {
  navigate: (to: string) => void;
  getQuery: (key: string) => string | null;
  setQuery: (key: string, value: string | null) => void;
}

export default function RecordPage({ navigate, getQuery, setQuery }: RecordPageProps) {
  const [openId, setOpenId] = useState<string | null>(() => getQuery('ingest'));
  const [visited, setVisited] = useState<string[]>([]);
  const topRef = useRef<HTMLElement>(null);
  const qc = useQueryClient();

  const open = (id: string) => {
    if (openId && openId !== id) setVisited((cur) => [openId, ...cur.filter((x) => x !== openId)]);
    setOpenId(id);
    setQuery('ingest', id);
    topRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  const close = () => {
    if (openId) setVisited((cur) => [openId, ...cur.filter((x) => x !== openId)]);
    setOpenId(null);
    setQuery('ingest', null);
  };
  const started = (id: string) => {
    open(id);
    void qc.invalidateQueries({ queryKey: recordKeys.list });
  };

  return (
    <UiNextRoot className="rc-page">
      <main className="rc-main" ref={topRef}>
        <header className="rc-head">
          <div className="rc-head-text">
            <h1 className="rc-title">把题放进来</h1>
            <p className="rc-sub">
              一张题、一整份卷子、PDF、Word，或者直接打一道。认出来的题都进题目库。
            </p>
          </div>
          <Mascot className="rc-mascot" />
        </header>

        <Composer onStarted={started} navigate={navigate} />

        <DraftSheet onStarted={started} />
        {openId && (
          <RecordingSheet key={openId} sessionId={openId} onClose={close} navigate={navigate} />
        )}

        <HistoryList openId={openId} visited={visited} onOpen={open} />
      </main>
    </UiNextRoot>
  );
}
