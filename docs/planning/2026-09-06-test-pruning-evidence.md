# Test-pruning evidence — YUK-957

基于 `origin/main` `b06c2c9ddd49ecd27172b7da010073e3c58f56ae`，本 lane 只删除迁移完成后仍重复扫描旧路径的 ownership 测试；不改变运行时代码、manifest、注册表、权限、schema 或业务断言。

| 文件 | 删除内容 | 保留的证据 |
| --- | --- | --- |
| `src/capabilities/agency/server/learning-intent.ownership.unit.test.ts` | central implementation / predecessor import 的递归源码扫描及其 helper/import | Agency-owned implementation、Notes/Knowledge public seam、无写循环 |
| `src/capabilities/practice/server/question-supply/ownership.unit.test.ts` | predecessor 文件存在性与旧 import 路径递归扫描及其专用常量 | public seam、read-port 无副作用、显式 command、owner/kernel seam |
| `src/capabilities/practice/server/quiz/ownership.unit.test.ts` | predecessor 文件存在性与旧 import 路径递归扫描及其专用常量 | 非 Practice consumer seam、handler 注册移除、owned modules 不依赖 public barrel |
| `src/capabilities/ingestion/server/tools/ownership.unit.test.ts` | central owner path/export/import/direct-registration 单测 | tool inventory/schema/effect、public read-model seam、read-port 无 mutation |
| `src/capabilities/knowledge/server/tools/ownership.unit.test.ts` | central owner path/export/import 单测 | failure-attempt public seam、tool inventory/schema/effect、read-port 无 mutation |

共删除 4 个迁移路径扫描 case，143 行（含只被这些 case 使用的 helper、常量和 imports）。这些删除不声称“旧目录永不出现”；不可达性仍由现有注册/依赖图与 public-seam 断言负责，运行时契约由 manifest/tool inventory 断言负责。

验证命令与结果：

- `pnpm vitest run --config vitest.unit.config.ts <上述 5 个文件>` — PASS, 5 files / 18 tests
- `pnpm typecheck` — PASS
- `pnpm lint` — PASS with repository baseline 322 warnings, 1 info; no error
- `pnpm build` — PASS (web, server, worker, migrate)
- `pnpm audit:capability-boundaries` — PASS, 444 / 0 / 47 ratchet counts
- `pnpm audit:architecture-deepening` — PASS, 444 / 0 / 47 dependency totals
