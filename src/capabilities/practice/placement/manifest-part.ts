// 定位 owner 的 manifest 片段，由根 `manifest.ts` 组合；条目随本 owner 的文件迁入。
import type { CapabilityManifest } from '@/kernel/manifest';

export const placementManifestPart: Omit<CapabilityManifest, 'name' | 'description'> = {};
