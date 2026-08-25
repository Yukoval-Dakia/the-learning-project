export class SupplyContractError extends Error {}
export function closureDirName(specifier: string): string;
export function platformKey(platform?: string, arch?: string): string;
export function parseLooseJson(text: string): any;
export function canonicalJson(value: unknown): string;
export function sha256Hex(buffer: string | Buffer): string;
export function bunLockResolutions(bunLockText: string): Set<string>;
export interface RuntimeGraphRow {
  path: string;
  name: string;
  version: string;
  integrity: string;
}
export function runtimeGraphRows(lock: any): RuntimeGraphRow[];
export function runtimeGraphSha256(rows: RuntimeGraphRow[]): string;
export interface ClosurePluginSpec {
  specifier: string;
  package: string;
  version: string;
  integrity: string;
  runtimePackageCount: number;
  runtimeGraphSha256: string;
}
export function validateClosureGraph(
  lock: any,
  plugin: ClosurePluginSpec,
  resolutions: Set<string>,
  approved?: { package: string; version: string; ownerSpecifier: string },
): number;
export function buildClosureManifest(fields: {
  schemaVersion: number;
  kind: string;
  platform: string;
  arch: string;
  opencodeVersion: string;
  plugins: ClosurePluginSpec[];
  entryCount: number;
}): string;
export function validateManifestAgainstInventory(
  manifest: any,
  inventory: any,
  context: { platform: string; arch: string },
): void;
