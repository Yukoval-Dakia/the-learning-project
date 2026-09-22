export function durationsFromVitestReport(report: unknown): Record<string, number>;
export function mergeShardFileDurations(executions: unknown[]): Record<string, number>;
export function findShardArtifactFiles(dir: string): {
  executions: string[];
  selections: string[];
};
