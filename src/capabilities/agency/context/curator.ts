// One Curator turn owns consolidation. The job only supplies its trigger.
import { piDomainMount, piToolWireName } from '@/ai/pi-tool-mount';
import { resolveTaskBudget } from '@/capabilities/task-registry';
import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { withinSessionAdvisoryLock } from '@/db/session-advisory-lock';
import { writeEvent } from '@/kernel/events';
import { advisoryLockRegistry } from '@/kernel/locks/registry';
import { agentNoteInputs, readAgentNotes } from '@/kernel/read-models/agent-note-hints';
import { readOvernightHandoffSentence } from '@/kernel/read-models/overnight-digest';
import { DOMAIN_TOOL_MCP_SERVER_NAME } from '@/kernel/tools/allowlists';
import { runAgentTask } from '@/server/ai/runner';
import {
  type CuratorLegacyScope,
  curatorEvidenceCoverage,
  curatorWatermarkAdvance,
  readCuratorLegacyScopes,
} from './curator-evidence';
import { buildCuratorPayload } from './curator-payload';
import { loadLearnerContext } from './index';
import { refreshTopicMetadata } from './topics';

/** Let a holder that just hit its run timer finish cleanup before calling it busy. */
const LOCK_WAIT_MARGIN_MS = 60_000;

export async function runCurator(db: Db, reason: 'nightly' | 'activity') {
  const runTimeoutMs = resolveTaskBudget('DreamingTask').timeout;
  return withinSessionAdvisoryLock(
    db,
    {
      key: advisoryLockRegistry.curatorConsolidation.key,
      busy: () => new Error('Curator consolidation busy'),
    },
    // The holder is one Dreaming run: wait its full budget (+ cleanup margin) so
    // an activity trigger is deferred, not dropped while the nightly run is live.
    new Date(Date.now() + runTimeoutMs + LOCK_WAIT_MARGIN_MS),
    () => runCuratorTurn(db, reason, runTimeoutMs),
  );
}

async function runCuratorTurn(db: Db, reason: 'nightly' | 'activity', runTimeoutMs: number) {
  const id = newId();
  const now = new Date();
  await writeEvent(db, {
    id,
    action: 'experimental:trigger_dreaming_scan',
    actor_kind: 'cron',
    actor_ref: 'curator',
    subject_kind: 'query',
    subject_id: id,
    payload: { reason },
    affected_scopes: [],
    ingest_at: now,
    created_at: now,
  });
<<<<<<< HEAD
  const [context, overnight] = await Promise.all([
=======
  const [context, evidence, topics, overnight, dreamingNotes] = await Promise.all([
>>>>>>> origin/main
    loadLearnerContext(db, { view: 'curator', now }),
    readOvernightHandoffSentence(db),
    readAgentNotes(db, { for_agent: 'dreaming', now }),
  ]);
  const legacyScopes: CuratorLegacyScope[] = await readCuratorLegacyScopes(db);
  const { payload, blocks, evidence } = await buildCuratorPayload(db, {
    anchorId: id,
    now,
    contextMarkdown: context.markdown,
    legacyScopes,
  });
  // Coverage bookkeeping for the watermark: only ids a `query_events` call
  // actually returned count as read. The index's excerpts are discovery — the
  // model saw them listed, but a row never retires the watermark on a listing.
  const readIds = new Set<string>();
  const toolNames = ['curate_context', 'query_context', 'query_events'];
  let noProgress = false;
  let writeFailed = false;
  let repeated = false;
  const seen = new Set<string>();
<<<<<<< HEAD
  let result: Awaited<ReturnType<typeof runAgentTask>>;
  try {
    result = await runAgentTask('DreamingTask', payload, {
=======
  const result = await runAgentTask(
    'DreamingTask',
    {
      context: context.markdown,
      evidence,
      legacy_scopes: legacyScopes,
      topic_freshness: (await topicBoard(db, now)).topics.map((t) => ({
        key: t.key,
        evidence_at: t.evidence_at,
        memory_weight: t.memory_weight,
        freshness: t.freshness,
        stale: t.stale,
      })),
      legacy_facts: (await readLegacyFacts(db)).filter(
        (f) => !f.evidence_ids.some((id) => withdrawnTopicEvidence(topics.digest).has(id)),
      ),
      ...topics,
      agent_notes: agentNoteInputs(dreamingNotes),
      instruction:
        '整理和压缩上下文，不决定做什么。接管 legacy_scopes 中所有 scope 的整理；即使没有新事件也检查陈旧程度，主题保留 scope_key，陈旧不等于错误。legacy-global 是旧摘要原文：第一次整理时把主题名、说明和正文改成学习者能懂的白话，不提迁移、升级或内部系统名；逐条保留所有经历事实及成功/失败、先后和不确定性，不能以清理建议为由丢掉事实。逐条 supersede 原事实，不合并 event/weakness；原文仍保留在旧 scope 和版本日志。只重写内容有变化的主题；没变化就停止。学习者 correction 最高优先。agent_notes 是学伴留给夜间整理的便签：只提示该留意什么，不是学习者事实，不能当作证据写入记忆；没有便签就与以往一样。',
    },
    {
>>>>>>> origin/main
      db,
      taskRunId: id,
      allowedTools: toolNames.map((name) => piToolWireName(DOMAIN_TOOL_MCP_SERVER_NAME, name)),
      piToolMounts: [
        piDomainMount({
          serverName: DOMAIN_TOOL_MCP_SERVER_NAME,
          taskKind: 'DreamingTask',
          toolNames,
          ctx: {
            db,
            taskRunId: id,
            providerAttemptCaller: 'worker',
            // A shorter window fails query_context deep reads (hard_deadline_exceeded)
            // while the run continues; match the run's own budget.
            providerSessionDeadlineAt: Date.now() + runTimeoutMs,
            callerActor: { kind: 'agent', ref: 'dreaming' },
            causedByEventId: id,
            derivationPolicy: 'allow',
          },
          beforeExecute: () =>
            noProgress ? 'No progress; finish this turn without further tools.' : undefined,
          onResult: (observation) => {
            const signature = JSON.stringify([
              observation.name,
              observation.input,
              observation.output,
            ]);
            if (seen.has(signature)) {
              noProgress = true;
              repeated = true;
            }
            if (
              observation.name === 'curate_context' &&
              (observation.error_reason ||
                !observation.executed ||
                (observation.output &&
                  typeof observation.output === 'object' &&
                  'status' in observation.output &&
                  observation.output.status === 'issue'))
            ) {
              writeFailed = true;
              noProgress = true;
            }
            seen.add(signature);
            if (
              observation.name === 'query_events' &&
              observation.output &&
              typeof observation.output === 'object'
            ) {
              const list = (observation.output as { events?: { id?: unknown }[] }).events;
              if (Array.isArray(list)) {
                for (const row of list) {
                  if (row && typeof row.id === 'string') readIds.add(row.id);
                }
              }
            }
            if (
              observation.name === 'curate_context' &&
              observation.output &&
              typeof observation.output === 'object' &&
              'status' in observation.output &&
              observation.output.status === 'unchanged'
            )
              noProgress = true;
          },
        }),
      ],
    });
  } catch (error) {
    // A failed run leaves a traceable degraded outcome and never advances the
    // watermark; the caller still receives the error.
    await writeEvent(db, {
      id: newId(),
      action: 'experimental:dreaming_scan',
      actor_kind: 'agent',
      actor_ref: 'dreaming',
      subject_kind: 'query',
      subject_id: id,
      outcome: 'degraded',
      payload: {
        task_run_id: id,
        error_head: error instanceof Error ? error.message.slice(0, 300) : String(error),
        watermark_advanced: false,
        input_blocks: blocks,
      },
      affected_scopes: [],
      ingest_at: new Date(),
    }).catch(() => {});
    throw error;
  }
  // With no covered prefix the watermark does not move; an incomplete window
  // retries on the next run and stays visible through the coverage block on
  // this scan record rather than silently dropping unread events.
  const advanceTo = curatorWatermarkAdvance(evidence.rows, readIds, now);
  const coverage = curatorEvidenceCoverage(evidence.rows, readIds, evidence.listedIds);
  // refreshTopicMetadata rethrows non-conflict errors — without a scan event
  // the whole turn would leave no trace. Record degraded, then rethrow so the
  // job still fails and retries.
  let refreshed = false;
  let refreshError: unknown;
  if (!writeFailed && !repeated) {
    try {
      refreshed = await refreshTopicMetadata(db, {
        taskRunId: result.task_run_id,
        asOf: advanceTo?.toISOString(),
        overnight,
        legacyGlobalVersion: legacyScopes.find((scope) => scope.scope === 'global')?.note?.version,
      });
    } catch (error) {
      refreshError = error;
    }
  }
  const watermarkAdvanced = advanceTo !== null && refreshed;
  await writeEvent(db, {
    id: newId(),
    action: 'experimental:dreaming_scan',
    actor_kind: 'agent',
    actor_ref: 'dreaming',
    subject_kind: 'query',
    subject_id: id,
    outcome:
      refreshError === undefined && watermarkAdvanced && coverage.complete
        ? 'success'
        : refreshError === undefined && watermarkAdvanced
          ? 'partial'
          : 'degraded',
    payload: {
      task_run_id: result.task_run_id,
      cost_usd: result.cost_usd,
      no_progress: noProgress,
      write_failed: writeFailed,
      ...(refreshError !== undefined
        ? { refresh_failed: refreshError instanceof Error ? refreshError.message : 'unknown' }
        : {}),
      coverage,
      watermark_advanced: watermarkAdvanced,
      watermark_to: watermarkAdvanced ? advanceTo?.toISOString() : null,
      input_blocks: blocks,
      model_input_tokens: result.usage.inputTokens,
      model_output_tokens: result.usage.outputTokens,
      model_turns: result.usage.numTurns ?? null,
    },
    affected_scopes: [],
    ingest_at: new Date(),
  });
  if (refreshError !== undefined) throw refreshError;
  return result;
}
