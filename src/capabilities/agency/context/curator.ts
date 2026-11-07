// One Curator turn owns consolidation. The job only supplies its trigger.
import { piDomainMount, piToolWireName } from '@/ai/pi-tool-mount';
import { resolveTaskBudget } from '@/capabilities/task-registry';
import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { withinSessionAdvisoryLock } from '@/db/session-advisory-lock';
import { writeEvent } from '@/kernel/events';
import { advisoryLockRegistry } from '@/kernel/locks/registry';
import { readOvernightHandoffSentence } from '@/kernel/read-models/overnight-digest';
import { DOMAIN_TOOL_MCP_SERVER_NAME } from '@/kernel/tools/allowlists';
import { runAgentTask } from '@/server/ai/runner';
import { type CuratorLegacyScope, readCuratorLegacyScopes } from './curator-evidence';
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
  const [context, overnight] = await Promise.all([
    loadLearnerContext(db, { view: 'curator', now }),
    readOvernightHandoffSentence(db),
  ]);
  const legacyScopes: CuratorLegacyScope[] = await readCuratorLegacyScopes(db);
  const { payload, blocks } = await buildCuratorPayload(db, {
    anchorId: id,
    now,
    contextMarkdown: context.markdown,
    legacyScopes,
  });
  const toolNames = ['curate_context', 'query_context', 'query_events'];
  let noProgress = false;
  let writeFailed = false;
  let repeated = false;
  const seen = new Set<string>();
  let result: Awaited<ReturnType<typeof runAgentTask>>;
  try {
    result = await runAgentTask('DreamingTask', payload, {
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
  const watermarkAdvanced =
    !writeFailed &&
    !repeated &&
    (await refreshTopicMetadata(db, {
      taskRunId: result.task_run_id,
      asOf: now.toISOString(),
      overnight,
      legacyGlobalVersion: legacyScopes.find((scope) => scope.scope === 'global')?.note?.version,
    }));
  await writeEvent(db, {
    id: newId(),
    action: 'experimental:dreaming_scan',
    actor_kind: 'agent',
    actor_ref: 'dreaming',
    subject_kind: 'query',
    subject_id: id,
    outcome: watermarkAdvanced ? 'success' : 'degraded',
    payload: {
      task_run_id: result.task_run_id,
      cost_usd: result.cost_usd,
      no_progress: noProgress,
      write_failed: writeFailed,
      watermark_advanced: watermarkAdvanced,
      input_blocks: blocks,
      model_input_tokens: result.usage.inputTokens,
      model_output_tokens: result.usage.outputTokens,
      model_turns: result.usage.numTurns ?? null,
    },
    affected_scopes: [],
    ingest_at: new Date(),
  });
  return result;
}
