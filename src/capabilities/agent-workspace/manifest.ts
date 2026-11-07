import { defineCapability } from '@/kernel/manifest';

export const agentWorkspaceCapability = defineCapability({
  name: 'agent-workspace',
  description: 'Fixed-identity script execution; controlled acceptance entry only.',
  copilotTools: {
    tools: [
      { name: 'workspace_exec', load: () => import('./public').then((m) => m.workspaceExec) },
    ],
  },
});
