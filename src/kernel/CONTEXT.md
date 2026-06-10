# kernel — 内核（P1，YUK-311）

只承载产品不变量的六契约（spec §2.1）。P1 已立：manifest/组合校验（manifest.ts）、
事件 facade（events.ts）、http facade（http.ts）。投影 / 提议生命周期 / 能动性策略 /
AI 运行时四契约 P2+ 按第二实例原则立——槽位登记在根部 ARCHITECTURE.md。

反框架护栏（spec 红线）：契约封顶 6、静态组合根（src/capabilities/index.ts）、
无动态加载、单使用方的钩子降级回包。新增字段/钩子前先问：第二个使用方在哪？
