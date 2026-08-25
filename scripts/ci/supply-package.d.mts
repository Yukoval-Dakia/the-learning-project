import type { ClosurePluginSpec } from './supply-graph.mjs';
export const MANIFEST_ENTRY: string;
export interface PackagedArtifact {
  archivePath: string;
  gzipPath: string;
  tarSha256: string;
  manifestSha256: string;
  entryCount: number;
  bytes: number;
}
export function packageArtifact(fields: {
  stagingRoot: string;
  inventory: any;
  resolutions: Set<string>;
  approved: { package: string; version: string; ownerSpecifier: string };
  outDir: string;
  platform?: string;
  arch?: string;
}): Promise<PackagedArtifact>;
export type { ClosurePluginSpec };
