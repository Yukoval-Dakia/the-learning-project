export class OfflineGuardError extends Error {}
export function buildOfflineWorkspaceTemplate(fields: {
  root: string;
  repoRoot: string;
  inventory: any;
}): Promise<string>;
export function pointWorkspaceAtExtractedPlugins(fields: {
  workspace: string;
  extractRoot: string;
  declaredPlugins: Array<{ specifier: string }>;
  inventory: { npmPlugins: Array<{ specifier: string; package: string }> };
}): Promise<void>;
export function startNetworkSentinel(): Promise<{
  port: number;
  attempts: string[];
  stop(): Promise<void>;
}>;
export function offlineLoaderEnv(home: string, sentinelPort: number): Record<string, string>;
export function runLoaderSnapshot(options: {
  loader: string;
  workspace: string;
  env: Record<string, string>;
  timeoutMs?: number;
}): Promise<{ tools: Record<string, boolean> }>;
