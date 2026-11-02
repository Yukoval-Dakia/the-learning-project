// 结算与撤回重放 owner 的 manifest 片段，由根 `manifest.ts` 组合；条目随本 owner 的文件迁入。
import type { CapabilityManifest } from '@/kernel/manifest';

export const settlementManifestPart: Omit<CapabilityManifest, 'name' | 'description'> = {};
