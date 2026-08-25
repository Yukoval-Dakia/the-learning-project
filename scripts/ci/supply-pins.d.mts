export type BootstrapPlatformPin = { key: string; seedRequired: true };
export type PinnedPlatformPin = {
  key: string;
  seedRequired: false;
  archiveSha256: string;
  manifestSha256: string;
  seedBuild: number;
};
export type PlatformPin = BootstrapPlatformPin | PinnedPlatformPin;
export interface SupplyPins {
  schemaVersion: number;
  approvedRuntimePlugin: { package: string; version: string; ownerSpecifier: string };
  artifactSource: { pipeline: string };
  platforms: Record<string, PlatformPin>;
}
export class SupplyContractError extends Error {}
export function loadPins(pinsPath: string): Promise<SupplyPins>;
export function isSeedRequired(platformEntry: PlatformPin | undefined): boolean;
export function requirePinnedPlatform(pins: SupplyPins, key: string): PinnedPlatformPin;
export function closureArtifactName(archiveSha256: string): string;
export function loaderArtifactName(platform: string, arch: string): string;
export function buildArtifactDownloadArgs(fields: {
  artifactName: string;
  destination: string;
  build: number | string;
  pipeline: string;
  currentPipeline: string | undefined;
}): string[];
export function bunLockLoaderIntegrity(
  bunLockText: string,
  platform: string,
  arch: string,
  version: string,
): string;
export interface SeedReceiptFields {
  platform: string;
  arch: string;
  pipeline: string;
  buildNumber: string;
  gitHead: string;
  seededAt: string;
  archiveSha256: string;
  manifestSha256: string;
  loaderIntegrity: string;
  loaderSpecifier: string;
}
export function buildSeedReceipt(fields: Partial<SeedReceiptFields>): string;
export const SEED_RECEIPT_KIND: string;
export const SEED_RECEIPT_METADATA_KEY: string;
