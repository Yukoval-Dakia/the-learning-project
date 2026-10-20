// YUK-598/599 — trait 装配溯源缓存的兼容入口。
//
// YUK-1567：模块本体迁至 `@/kernel/read-models/subject-trait-resolutions`
// （capability 侧付费输入消费者不得深 import server/subjects；kernel
// read-models 是共享 seam）。行为、导出面与写入纪律不变——hydrate 仍是唯一
// 写者，每轮整体换 Map 引用。
export {
  type TraitDegradation,
  type TraitResolution,
  getSubjectTraitResolutions,
  isGeneralFallbackFor,
  replaceSubjectTraitResolutions,
} from '@/kernel/read-models/subject-trait-resolutions';
