export const SCHEMA_VERSION = '1.0';

// CF Worker free plan caps at 50 subrequests per request. We use 18 D1 SELECTs
// + a few R2 reads for assets + future-proof headroom. Cap inline assets at 45;
// users with more must use refs-only export + wrangler r2 cp sidecar.
// Paid plan = 1000 subrequests; bump to ~950 if you upgrade.
export const MAX_INLINE_ASSETS = 45;

// FK topological order. Insert sweeps forward; wipe sweeps reverse. Any schema
// change that adds/removes/renames a table MUST update this array AND bump
// SCHEMA_VERSION in lockstep.
export const FK_ORDER = [
  'knowledge',
  'source_asset',
  'source_document',
  'ingestion_session',
  'question_block',
  'question',
  'mistake',
  'review_event',
  'learning_item',
  'completion_evidence',
  'study_log',
  'artifact',
  'answer',
  'judgment',
  'user_appeal',
  'dreaming_proposal',
  'tool_call_log',
  'cost_ledger',
] as const;

export type TableName = (typeof FK_ORDER)[number];
