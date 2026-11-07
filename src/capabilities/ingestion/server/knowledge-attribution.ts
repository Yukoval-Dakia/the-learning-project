/**
 * One owner for "attribute this ingested question to a knowledge point" (YUK-1994).
 *
 * Both the enroll path and the background knowledge backfill call this, so subject
 * classification, PROPOSE naming and the unified match-or-propose rule cannot drift
 * between an immediate enrollment and a repair run. A failure is thrown to the caller:
 * enrollment marks the question `knowledge: 'missing'`, the backfill counts a bounded
 * attempt. Neither is an enrollment gate.
 */
import {
  type ColdStartBridgeRunTaskFn,
  runColdStartBridge,
} from '@/capabilities/ingestion/server/cold-start-bridge';
import {
  createKnowledgeNamer,
  createKnowledgeTagEmbedder,
} from '@/capabilities/ingestion/server/knowledge-namer';
import type { Db } from '@/db/client';
import { type NameKcFn, tagKnowledge } from '@/kernel/records/knowledge-tag';
import { getKnownSubjects } from '@/subjects/profile';
import { redactIngestionText } from './privacy-guard';

export interface AttributeIngestionKnowledgeParams {
  db: Db;
  /** Redaction happens here; callers pass the raw stored prompt. */
  questionMd: string;
  knowledgeHint: string | null;
  /** Known subject id when the caller already resolved it; otherwise classify. */
  subjectId?: string;
  providerAttempt?: Parameters<typeof createKnowledgeTagEmbedder>[0];
  /** Test seam for both the bridge and the naming call. */
  runTaskFn?: ColdStartBridgeRunTaskFn;
  /** Test seam for the enroll-path tagging call. */
  tagKnowledgeFn?: typeof tagKnowledge;
  /** Per-upload cache so siblings proposing one name reuse the first id. */
  batchCache?: Map<string, string>;
  /** Binds tag audit events to the ingestion session (retroactive consent filter). */
  sessionId?: string | null;
  /** Audit-only provenance anchor; never read by the decision. */
  sourceRef?: { kind: string; id: string } | null;
  ctx?: unknown;
}

export interface AttributedIngestionKnowledge {
  knowledgeIds: string[];
  /** The cold-start classification run, when one was made. */
  bridgeTaskRunId?: string;
  bridgeCostUsd?: number;
}

export async function attributeIngestionKnowledge(
  params: AttributeIngestionKnowledgeParams,
): Promise<AttributedIngestionKnowledge> {
  const tagKnowledgeFn = params.tagKnowledgeFn ?? tagKnowledge;
  let subjectRootId: string;
  let bridgeNameKc: NameKcFn | undefined;
  let bridgeTaskRunId: string | undefined;
  let bridgeCostUsd: number | undefined;

  if (params.subjectId) {
    subjectRootId = `seed:${params.subjectId}:root`;
  } else {
    const bridge = await runColdStartBridge({
      db: params.db,
      questionMd: params.questionMd,
      // Placeholder forces the ECHO path; only the classified subject_id is used.
      existingReferenceMd: '(reference answer not needed for tagging)',
      knowledgeHint: params.knowledgeHint,
      knownSubjects: getKnownSubjects(),
      runTaskFn: params.runTaskFn,
      ctx: params.ctx ?? { db: params.db },
    });
    subjectRootId = `seed:${bridge.subject_id}:root`;
    bridgeTaskRunId = bridge.task_run_id;
    bridgeCostUsd = bridge.cost_usd;
    // Reuse the classified name so a PROPOSE makes no second model call, and
    // forward the bridge run's provenance for the tag audit event (YUK-1604).
    bridgeNameKc = async () => ({
      kc_name: bridge.kc_name,
      ...(bridge.task_run_id !== undefined ? { task_run_id: bridge.task_run_id } : {}),
      ...(bridge.cost_usd !== undefined ? { cost_usd: bridge.cost_usd } : {}),
    });
  }

  const tag = await tagKnowledgeFn(
    {
      db: params.db,
      embedder: createKnowledgeTagEmbedder(params.providerAttempt),
      nameKcFn:
        bridgeNameKc ??
        createKnowledgeNamer({
          db: params.db,
          runTaskFn: params.runTaskFn,
          ctx: params.ctx ?? { db: params.db },
        }),
      batchCache: params.batchCache,
    },
    {
      // Redact identifiers at the model boundary; redact the hint too so audit
      // events match the model-facing contract. sessionId binds the events to this
      // ingestion session for the live derivation policy.
      questionText: redactIngestionText(params.questionMd).text,
      knowledgeHint: params.knowledgeHint
        ? redactIngestionText(params.knowledgeHint).text
        : params.knowledgeHint,
      sessionId: params.sessionId ?? null,
      subjectRootId,
      sourceRef: params.sourceRef ?? null,
    },
  );

  return {
    knowledgeIds: tag.knowledge_ids,
    ...(bridgeTaskRunId !== undefined ? { bridgeTaskRunId } : {}),
    ...(bridgeCostUsd !== undefined ? { bridgeCostUsd } : {}),
  };
}
