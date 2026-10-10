import { canonicalHash } from '@/core/migration/canonical';

export function ingestionCaptureIdentity(block: {
  ingestion_session_id: string;
  id: string;
  version: number;
}) {
  const captureId = canonicalHash({
    session: block.ingestion_session_id,
    block: block.id,
    version: block.version,
  }).slice(0, 40);
  return { captureId, questionId: `q_capture_${captureId}` };
}
