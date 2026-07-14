# src/capabilities — capability 包总览

> 后端 surface 的真相源。每个包通过 `manifest.ts` 声明自己拥有的路由、jobs、proposal kinds、copilot tools、UI 面；`src/capabilities/index.ts` 静态聚合所有 manifests 并交给 `server/app.ts` 挂载。

## STRUCTURE
```
src/capabilities/
  index.ts            # 静态组合根：按顺序聚合 9 个 capability manifests
  agency/             # 能动编排：夜链 + goal scope + agent-notes
  copilot/            # Copilot 单人格对话 + copilotTools 贡献
  ingestion/          # 录入域：OCR / Vision rescue / 抽取 / 入库
  knowledge/          # 知识图谱域：树 + mesh + 提议 + 归因
  notes/              # Note artifact 域：block-tree 编辑器 + Living Note refine
  observability/      # AI 可观测性：admin 四页 + 今日成本条
  onboarding/         # 冷启动：目标、上传、起点探测与起始档案
  practice/           # 练习域：review / quiz / judge / paper / 题库
  shell/              # 工作台壳层：收件箱 + Today + Coach
```

## WHERE TO LOOK
| 任务 | 位置 |
|------|------|
| 组合根 / 全局唯一性校验 | `index.ts` + `src/kernel/manifest.ts` 的 `validateComposition()` |
| 某包路由/job/tool/ui 归属 | 该包 `manifest.ts` |
| 路由 handler | 该包 `api/*.ts` |
| pg-boss job handler | 该包 `jobs/*.ts`（部分仍过渡在 `src/server/boss/handlers/`） |
| UI 页面 | 该包 `ui/*.tsx` |
| proposal accept applier | 该包 `server/proposal-appliers.ts`（或等效文件） |

## CONVENTIONS
- 包只依赖 `@/kernel/*` + 自身 + 共享 UI 件（`@/ui/primitives`、`@/ui/lib`）。
- 包间走 manifest 公共接口；禁深层 import。
- 迁移期豁免：kernel facade 可包装遗留 `src/server/**`；capability 暂可 import `@/db/client`/`@/db/schema`。
- 测试命名：`src/kernel/**` 与 `src/capabilities/**` 的 `*.unit.test.ts` 自动进无 DB 车道，`*.db.test.ts` 自动进 testcontainer 车道。

## ANTI-PATTERNS
- 别把业务逻辑漏在 capability 包之外又不去 manifest 登记。
- 别跨包 import 具体实现；要调用其他域，通过组合根聚合后的公共端点或工具贡献制。
