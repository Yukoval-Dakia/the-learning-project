// 内核 http 错误整形 facade（P1 薄壳，YUK-311）— 包装遗留 @/server/http/errors，
// capability 包的 API handler 统一从这里取 ApiError/errorResponse。
export { ApiError, errorResponse } from '@/server/http/errors';
