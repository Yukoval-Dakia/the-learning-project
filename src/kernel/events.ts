// 内核契约「事件存储」facade（P1 薄壳，YUK-311）。
// 包装遗留单一写入口 writeEvent（ADR-0005 single-owner）。capability 包只许
// import '@/kernel/events'；底层模块在事件契约完整立起时（P2+）迁入内核本体。
export { writeEvent as emitEvent } from '@/server/events/queries';
export type { EventT } from '@/core/schema/event';
