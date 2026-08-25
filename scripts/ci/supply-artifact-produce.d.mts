import type { ClosurePluginSpec } from './supply-graph.mjs';
export function materializeClosures(fields: {
  closuresRoot: string;
  stagingRoot: string;
  inventory: any;
}): Promise<string[]>;
export function fetchPinnedOpencodeTarball(fields: {
  outDir: string;
  bunLockText: string;
  inventory: any;
  platform: string;
  arch: string;
  expectedIntegrity?: string;
}): Promise<{ path: string; integrity: string; specifier: string }>;
export type { ClosurePluginSpec };
