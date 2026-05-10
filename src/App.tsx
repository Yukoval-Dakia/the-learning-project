import { Navigate, Route, Routes } from 'react-router-dom';
import { Home } from './routes/index';
import { Inspect } from './routes/inspect';
import { KnowledgeTree } from './routes/knowledge';
import { KnowledgeProposals } from './routes/knowledge-proposals';
import { MistakesList } from './routes/mistakes-list';
import { CaptureSession } from './routes/capture';
import { ReviewSession } from './routes/review';
import { LearningItemsList } from './routes/learning-items';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/_/inspect" element={<Inspect />} />
      <Route path="/knowledge" element={<KnowledgeTree />} />
      <Route path="/knowledge/proposals" element={<KnowledgeProposals />} />
      <Route path="/mistakes" element={<MistakesList />} />
      <Route path="/capture" element={<CaptureSession />} />
      <Route path="/ingest" element={<Navigate to="/capture" replace />} />
      <Route path="/review" element={<ReviewSession />} />
      <Route path="/learning-items" element={<LearningItemsList />} />
    </Routes>
  );
}
