export class ConsumeFailure extends Error {}
export interface ConsumeSummary {
  archiveSha256: string;
  manifestSha256: string;
  tools: string[];
  networkAttempts: number;
  entries: number;
}
export function consumeArtifact(fields: {
  archivePath: string;
  loaderPath: string;
  pinsPath: string;
  inventory: any;
  bunLockText: string;
  workspaceTemplateDir: string;
  scratchRoot: string;
  timeoutMs?: number;
}): Promise<ConsumeSummary>;
