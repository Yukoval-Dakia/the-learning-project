export type GateLane = 'static' | 'unit' | 'db' | 'migration' | 'build' | 'usability';

export interface GatePlan {
  schema_version: 1;
  code_changed: boolean;
  changed_files: string[];
  lanes: Record<GateLane, boolean>;
  unit_selection: 'skip' | 'affected' | 'full';
  reasons: string[];
}

export function classifyChangedFiles(
  inputFiles: string[],
  options?: { forceFullReason?: string },
): GatePlan;

export function parseNulDelimitedPaths(output: string | Buffer): string[];

export function readGitChangedFiles(mergeBase: string, head?: string, root?: string): string[];
