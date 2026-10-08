import type { AdminConfigRuntimeFacts } from '@/capabilities/observability/public';
import type {
  AdminControlClient,
  TraitJournalData,
} from '@/capabilities/observability/ui/admin-control-client';
import { configFixture } from '@/capabilities/observability/ui/config-test-fixture';
import { SubjectTraitsWireSchema } from '@/capabilities/observability/ui-public';

export const controlRuntime: AdminConfigRuntimeFacts['runtime'] = {
  port: null,
  db_pool_max: 4,
  queue_tiers: { expire_seconds: { fast: 120, llm: 600, agent: 1800 }, retention_seconds: 3600 },
  orchestration: {
    anchor_cron: '0 2 * * *',
    tz: 'Asia/Tokyo',
    queue: 'fixture',
    catchup_window_seconds: 120,
    tick_interval_seconds: 5,
    node_timeout_seconds: 300,
    layer_stagger_seconds: 5,
    dag_members: ['one', 'two'],
  },
};
export const controlConfig = () => ({ ...configFixture(), runtime: controlRuntime });
export const controlSubjects: Awaited<ReturnType<AdminControlClient['getSubjects']>> = {
  subjects: [
    {
      id: 'general',
      displayName: 'General',
      origin: 'builtin',
      retiredAt: null,
      isGeneralFallback: null,
      version: 'jt:general@3',
      subjectRevision: 3,
      notation: null,
      capabilityCount: 0,
    },
    {
      id: 'custom',
      displayName: '含条件与歧义的科目',
      origin: 'custom',
      retiredAt: null,
      isGeneralFallback: false,
      version: 'jt:charter@5',
      subjectRevision: 8,
      notation: null,
      capabilityCount: 2,
    },
    {
      id: 'retired',
      displayName: '历史科目',
      origin: 'custom',
      retiredAt: '2026-10-08T23:00:00.123Z',
      isGeneralFallback: true,
      version: null,
      subjectRevision: 2,
      notation: null,
      capabilityCount: 0,
    },
  ],
};
export const controlTraits = SubjectTraitsWireSchema.parse({
  subjectRevision: 8,
  bindings: [
    {
      kind: 'charter',
      traitId: 'seed/charter',
      origin: 'builtin',
      ownerSubjectId: null,
      seedVersion: '1.0.0',
      revision: 3,
      effectiveRevision: 'seed:1.0.0',
      degraded: 'code_seed',
      payload: {
        languageStyle: '平实',
        methodology: '证据与限制。'.repeat(150),
        nested: { alternatives: [null, true, '保留'] },
      },
      sharedBy: ['general', 'custom', 'retired'],
    },
  ],
});
export const controlJournal: TraitJournalData = {
  data: [],
  journal: [
    {
      revision: 2,
      action: 'edit',
      actor: 'owner',
      createdAt: '2026-10-09T00:00:00.456Z',
      payloadSchemaVersion: 1,
      seedVersion: '1.0.0',
      sourceTraitId: null,
      sourceRevision: null,
      rolledBackFrom: null,
      changeSeq: 17,
    },
  ],
  page: { limit: 100, next_cursor: 'opaque-next' },
  next_cursor: 'opaque-next',
};
controlJournal.data = controlJournal.journal;
export const controlReceipt = {
  committed_epoch: 5,
  snapshot_epoch: 4,
  snapshot_current: false,
  changes: [],
};
