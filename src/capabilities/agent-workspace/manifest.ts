import { defineCapability } from '@/kernel/manifest';
import { AGENT_WORKSPACE_SWEEP_QUEUE } from '@/server/boss/queue-names';

export const agentWorkspaceCapability = defineCapability({
  name: 'agent-workspace',
  description:
    'Fixed-identity script execution in durable per-owner workspaces; controlled acceptance entry only.',
  copilotTools: {
    tools: [
      { name: 'workspace_exec', load: () => import('./public').then((m) => m.workspaceExec) },
      { name: 'workspace_files', load: () => import('./public').then((m) => m.workspaceFiles) },
    ],
  },
  jobs: {
    handlers: [
      {
        // Zero-LLM housekeeping: reclaims provably dead leases, translates owner
        // tombstones/expiry/finished task runs into revocations, then tombstones
        // and removes directories. Five-minute cadence; bounded by the pool size.
        name: AGENT_WORKSPACE_SWEEP_QUEUE,
        schedule: {
          cron: '*/5 * * * *',
          tz: 'Asia/Shanghai',
          singletonKey: 'agent_workspace_sweep-run',
          singletonSeconds: 300,
        },
        queue: 'fast',
        load: () =>
          import('./jobs/agent_workspace_sweep').then((m) => m.buildAgentWorkspaceSweepHandler),
      },
    ],
  },
});
