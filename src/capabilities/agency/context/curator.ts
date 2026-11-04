// One Curator turn owns consolidation. The job only supplies its trigger.
import { piDomainMount } from '@/ai/pi-tool-mount';
import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { writeEvent } from '@/kernel/events';
import { readOvernightHandoffSentence } from '@/kernel/read-models/overnight-digest';
import { DOMAIN_TOOL_MCP_SERVER_NAME, resolveDomainToolNames, resolveMcpAllowedTools } from '@/kernel/tools/allowlists';
import { runAgentTask } from '@/server/ai/runner';
import { loadLearnerContext } from './index';
import { readCuratorEvidence } from './curator-evidence';
import { changeTopics, readTopics } from './topics';

export async function runCurator(db: Db, reason: 'nightly' | 'activity') {
  const id = newId();
  const now = new Date();
  await writeEvent(db, { id, action: 'experimental:trigger_dreaming_scan', actor_kind: 'cron',
    actor_ref: 'curator', subject_kind: 'query', subject_id: id, payload: { reason },
    affected_scopes: [], ingest_at: now, created_at: now });
  const [context, evidence, topics, overnight] = await Promise.all([
    loadLearnerContext(db, { view: 'curator', now }), readCuratorEvidence(db, id), readTopics(db),
    readOvernightHandoffSentence(db),
  ]);
  let noProgress = false;
  const result = await runAgentTask('DreamingTask', {
    context: context.markdown, evidence, ...topics,
    instruction: '整理和压缩上下文，不决定做什么。只重写有变化的主题；没变化就停止。weakness/event 不可合并。学习者 correction 最高优先。',
  }, {
    db, taskRunId: id,
    allowedTools: [...resolveMcpAllowedTools('dreaming')],
    piToolMounts: [piDomainMount({ serverName: DOMAIN_TOOL_MCP_SERVER_NAME,
      taskKind: 'DreamingTask', toolNames: resolveDomainToolNames('dreaming'),
      ctx: { db, taskRunId: id, providerAttemptCaller: 'worker', providerSessionDeadlineAt: Date.now() + 120_000,
        callerActor: { kind: 'agent', ref: 'dreaming' }, causedByEventId: id, derivationPolicy: 'allow' },
      beforeExecute: () => noProgress ? 'No progress; finish this turn without further tools.' : undefined,
      onResult: observation => {
        if (observation.name === 'curate_context' && observation.output && typeof observation.output === 'object' &&
          'status' in observation.output && observation.output.status === 'unchanged') noProgress = true;
      },
    })],
  });
  const current = await readTopics(db);
  await changeTopics(db, { expectedVersion: current.version, actor: 'curator', taskRunId: result.task_run_id,
    sourceIds: [], patches: [], asOf: now.toISOString(), overnight });
  await writeEvent(db, { id: newId(), action: 'experimental:dreaming_scan', actor_kind: 'agent',
    actor_ref: 'dreaming', subject_kind: 'query', subject_id: id, outcome: 'success',
    payload: { task_run_id: result.task_run_id, cost_usd: result.cost_usd, no_progress: noProgress },
    affected_scopes: [], ingest_at: new Date() });
  return result;
}
