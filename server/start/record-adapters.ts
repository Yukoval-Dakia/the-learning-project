import { createStartIngestionOperation } from './ingestion-operation-create-operation';
import { createStartIngestionSession } from './ingestion-session-create-operation';
import { answerStartRecordAsk } from './record-ask-answer-operation';
import { readStartRecordBlocks } from './record-blocks-reader';
import { createStartRecordManualMistake } from './record-manual-mistake-operation';
import { changeStartRecordPurpose } from './record-purpose-change-operation';
import { readStartRecordPurposeImpact } from './record-purpose-impact-reader';
import { revertStartRecordBlock } from './record-revert-operation';
import { readStartRecordSessionDetail } from './record-session-detail-reader';
import { readStartRecordSessionHistory } from './record-session-history-reader';
import { readStartRecordSessions } from './record-session-list-reader';

// One family surface, constructed in the API graph when a Start operation first asks
// for it; each adapter keeps owning its own conversion, error and deadline handling.
export const recordAdapters = {
  createStartIngestionSession,
  createStartIngestionOperation,
  answerStartRecordAsk,
  changeStartRecordPurpose,
  readStartRecordPurposeImpact,
  readStartRecordBlocks,
  createStartRecordManualMistake,
  revertStartRecordBlock,
  readStartRecordSessionDetail,
  readStartRecordSessionHistory,
  readStartRecordSessions,
};
