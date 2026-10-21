// 兼容 re-export：ApiError/errorResponse 本体已在 @/kernel/http。
// 新代码直接从 @/kernel/http 取；此处仅供存量调用，禁新增直穿（见 biome noRestrictedImports）。
export { ApiError, errorResponse } from '@/kernel/http';
