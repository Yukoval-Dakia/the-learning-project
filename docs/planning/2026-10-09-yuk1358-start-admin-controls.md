# YUK-1358 Start 配置与科目管理接线

## 范围与责任

从 main f80d47703 开始。57961995 负责 Start 集成与本切片交付；7631 继续独占 agency board read 领域线，并承担其声明的整体迁移协调责任。只有一名源码 writer。复用1390/1391公共操作，不重复hydrate或创建配置writer。

依据 docs/planning/2026-10-07-non-ui-migration-priority.md 第9行：“先完成整个非 UI 技术迁移，保留现有页面及行为；视觉设计与 UI 重写暂缓”。组件类型为现有 page 的 route/data 适配，不做视觉或交互重设计。

预期修改：server/start 下配置/subjects RPC、边界、client与三条route及routeTree；必要 server/frontdoor.ts / start/context.ts 的canonical依赖注入；observability/ui 下config、subjects、subject-traits及嵌套catalog/journal的客户端注入；web/src/router.tsx过渡handoff与scoped tests。领域public与写者保持不改，package/lock不改。

## 验收

- 鉴权和epoch检查早于输入解析、领域加载和DB获取；失败没有效果。
- canonical config facts/store/writer必须来自实际已初始化模块，不能假定Start bundle与Hono共享模块单例。保留未注入503和facts不足事实。
- config提交receipt先记录，读刷新失败不重写；worker ACK不伪称。
- subject/trait完整CAS、422、general限制、COW、fan-out、noop及提交后hydrate保持。Start错误适配保留ApiError details供现有UI判断。
- catalog/journal所有嵌套消费者接线；默认100/cap200/trait cursor保持，不能用无界read。
- scoped unit、父独立DB、built RPC/browser、独立review与准确CI分别留证；实际runtime验收先核锁，不碰主测试数据或provider。
- 仅完成这三页面不等于所有路由/旧SPA/任务恢复退出。
