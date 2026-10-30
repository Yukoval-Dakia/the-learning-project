# kernel — 内核（P1，YUK-311）

产品契约限于产品不变量的六契约（spec §2.1）。P1 已立：manifest/组合校验（manifest.ts）、
事件 facade（events.ts）、http facade（http.ts）。投影 / 提议生命周期 / 能动性策略 /
AI 运行时四契约 P2+ 按第二实例原则立——槽位登记在根部 ARCHITECTURE.md。

server-only 共享对象 I/O 由 `object-storage.ts` 完整拥有，不新增产品契约槽；
仅此端口的 SDK 依赖及调用范围见 [AGENTS.md](AGENTS.md)，资产引用与恢复协议仍归原 owner。

反框架护栏（spec 红线）：契约封顶 6、静态组合根（src/capabilities/index.ts）、
无动态加载、单使用方的钩子降级回包。新增字段/钩子前先问：第二个使用方在哪？
