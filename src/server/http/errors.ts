// Re-export 过渡壳（YUK-770）— ApiError/errorResponse 本体已迁入 @/kernel/http。
// 新代码请直接从 @/kernel/http 取；此处仅为存量兼容保留，禁新增直穿（见 biome noRestrictedImports）。
export { ApiError, errorResponse } from '@/kernel/http';
