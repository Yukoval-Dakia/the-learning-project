# Test-pruning evidence — YUK-957

基于 `origin/main` `b06c2c9ddd49ecd27172b7da010073e3c58f56ae`，本 lane 只删除迁移完成后仍重复扫描旧路径的 ownership 测试；不改变运行时代码、manifest、注册表、权限、schema 或业务断言。

| 文件 | 删除内容 | 保留的证据 |
| --- | --- | --- |
| `src/capabilities/agency/server/learning-intent.ownership.unit.test.ts` | central implementation / predecessor import 的递归源码扫描及其 helper/import | Agency-owned implementation、Notes/Knowledge public seam、无写循环 |
| `src/capabilities/practice/server/question-supply/ownership.unit.test.ts` | predecessor 文件存在性与旧 import 路径递归扫描及其专用常量 | public seam、read-port 无副作用、显式 command、owner/kernel seam |
| `src/capabilities/practice/server/quiz/ownership.unit.test.ts` | predecessor 文件存在性与旧 import 路径递归扫描及其专用常量 | 非 Practice consumer seam、handler 注册移除、owned modules 不依赖 public barrel |
| `src/capabilities/ingestion/server/tools/ownership.unit.test.ts` | central owner path/export/import 扫描；原 registration 约束单独保留 | `keeps concrete registrations out of the central registry infrastructure`；tool inventory/schema/effect、public read-model seam、read-port 无 mutation |
| `src/capabilities/knowledge/server/tools/ownership.unit.test.ts` | central owner path/export/import 单测 | failure-attempt public seam、tool inventory/schema/effect、read-port 无 mutation |

移除5个混合旧路径扫描case，但将其中的central registration保护独立保留，净减少4个case。测试代码删除119行、新增5行（净减114行），含专用 helper、常量和 imports。这些删除不声称“旧目录永不出现”；有效生产者仍由现有注册/依赖图与 public-seam 检查约束，运行时契约由manifest中 `loads the unchanged tool inventory and contracts` 的真实loader断言负责。独立初审APPROVE；root额外保留原registration保护，避免清理路径断言时损失该独立约束。

验证命令与结果：

- `pnpm vitest run --config vitest.unit.config.ts <上述 5 个文件>` — PASS, 5 files / 19 tests（root最终复验）
- `pnpm typecheck` — PASS
- `pnpm lint` — PASS；root另外删除遗留的unused OWNERSHIP_TEST常量，不把新增warning称作既有基线。
- `pnpm build` — PASS (web, server, worker, migrate)
- `pnpm audit:capability-boundaries` — PASS, 444 / 0 / 47 ratchet counts
- `pnpm audit:architecture-deepening` — PASS, 444 / 0 / 47 dependency totals
