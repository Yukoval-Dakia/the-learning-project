import type { PinnedPlatformPin, PlatformPin, SupplyPins } from './supply-pins.mjs';
export function downloadPinnedArtifacts(fields: {
  pins: SupplyPins;
  platform: string;
  arch: string;
  downloadDir: string;
  currentPipeline: string | undefined;
  runAgent: (argv: string[]) => void;
}): { archivePath: string; loaderPath: string; pinned: PinnedPlatformPin };
export function acquirePinnedArtifacts(fields: {
  pins: SupplyPins;
  platform: string;
  arch: string;
  downloadDir: string;
  extractRoot: string;
  currentPipeline: string | undefined;
  bunLockText: string;
  loaderVersion: string;
  runAgent: (argv: string[]) => void;
}): Promise<{ archivePath: string; loaderPath: string }>;
export type { PinnedPlatformPin, PlatformPin, SupplyPins };
