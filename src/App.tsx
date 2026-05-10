import { Route, Routes } from 'react-router-dom';
import { Home } from './routes/index';
import { Inspect } from './routes/inspect';
import { KnowledgeTree } from './routes/knowledge';
import { KnowledgeProposals } from './routes/knowledge-proposals';
import { RecordMistake } from './routes/record';
import { MistakesList } from './routes/mistakes-list';
import { IngestSession } from './routes/ingest';
import { ReviewSession } from './routes/review';
import { LearningItemsList } from './routes/learning-items';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/_/inspect" element={<Inspect />} />
      <Route path="/knowledge" element={<KnowledgeTree />} />
      <Route path="/knowledge/proposals" element={<KnowledgeProposals />} />
      <Route path="/record" element={<RecordMistake />} />
      <Route path="/mistakes" element={<MistakesList />} />
      <Route path="/ingest" element={<IngestSession />} />
      <Route path="/review" element={<ReviewSession />} />
      <Route path="/learning-items" element={<LearningItemsList />} />
    </Routes>
  );
}
