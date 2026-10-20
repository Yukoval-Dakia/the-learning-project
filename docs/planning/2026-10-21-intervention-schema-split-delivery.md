# YUK-1572 — intervention schema 三段拆分（交付记录）

候选 brief：`src/core/schema/intervention.ts`（2268 行）把三类职责叠在一个文件里：
业务构造契约、当前评审/审计绑定协议、历史持久化格式解码。本片按职责拆为三个模块，
公共 import 面 `@/core/schema/intervention` 与其全部 95 个导出（含 type/value 分类）不变。

## 元数据

- base：`ce74a7733f93044f55c0b00d056ae3c8d137f1fc`（fixed main）
- branch：`arch/intervention-schema-split`
- worktree：`/Users/yuqi/.t3/worktrees/the-learning-project/t3-7f2c17bf`
- head / diff hash / 校验输出原件：外部证据目录
  `tlp-audit-artifacts/architecture-deepening/YUK-1572/<head>/intervention-schema/`

## 逐文件范围

| 文件 | 行数 | 内容 |
|---|---|---|
| `src/core/schema/intervention.ts` | 2268 → 990 | 业务构造契约与公开面组装：snapshot/recommendation/settlement/package/preparation/authoring 全部 schema、settlement 构造与 reanchor、确定性校验、reverse-causation 抽取、review requirements、task-input builder；尾部为公开 re-export 区 |
| `src/core/schema/intervention-review.ts` | 919（新） | 当前评审/审计协议：协议版本常量、failure code 词表、diagnostic kind、reverse-causation claim 上限与 schema、required-operation 检查与 `interventionRequiredOperationDigest`、独立解题/内容校验审计、V2/V3/Current 评审 audit 与全部当前绑定 refinement |
| `src/core/schema/intervention-review-history.ts` | 456（新） | 历史只读解码：Legacy model output 与 audit、早期 V2 / pre-operation-binding 历史形状、`InterventionPackageReviewAudit`/`ModelOutput` 版本宽容 union reader |

protected/其他文件：diff 仅含上表一改动 + 两新增；36 个消费者与全部测试逐 blob 无变
（`git status`/`git diff --stat` 证据封存外部目录）。

## 拆分边界为何成立

历史格式兼容与当前审计绑定是两条真实会独立变化的职责：

- **场景 1 — 历史格式兼容演进**：新增一个更老的持久化形状（例如再发现
  pre-V2 记录变体）。Before：在 2268 行业务+协议混合文件里改 reader 并担心
  误伤当前绑定 refinement。After：只改 `intervention-review-history.ts`，
  加形状并进 union；当前 V3/V2 绑定与 digest 逻辑不在该文件，无法被误改。
- **场景 2 — 当前因果证据绑定演进**：收紧或扩展当前绑定规则（如新 claim 类别、
  新 required-operation 维度、V4 协议）。Before：同一文件里当前 refinement 与
  历史宽容 reader 相邻，改 current 易被兼容诉求传染成「新字段 optional」。
  After：只改 `intervention-review.ts`；历史 reader 依赖的共享锚点
  （`AuditV2Fields`/`RequiredOperationChecks`/`refineInterventionPackageReviewAuditBindings`）
  是三个显式内部出口，历史形状的宽容语义不受当前严格化波及。

caller 少知：消费者仍只 import `@/core/schema/intervention`，连「历史/当前是
两个文件」这一事实都不需要知道；`contracts.ts` facade 的 26 个 re-export 不变。

## 五标准对账（诚实项）

1. **责任**：三文件各承载一条可独立变化的责任（业务构造 / 当前协议绑定 /
   历史解码）。成立。
2. **接口**：内部缝收窄到必需——history 仅从 review 复用 3 个组合件 +
   11 个已公开符号；无新 registry/shim/豁免。成立。
3. **隐藏知识**：历史宽容语义（哪些字段可缺）现在只存在 history 模块；
   当前严格绑定（task id 唯一性、末次 attempt digest 相等、双 pass 门槛）
   只存在 review 模块。成立。
4. **修改局部性**：见两场景；两场景下另一模块均为只读依赖。成立。
5. **行为证据**：静态见下；运行时 gate 因本树无 node_modules 全部 NOT_RUN，
   如实上报父安排 frozen install。**不声称 typecheck/test 已过。**

## 行为保持证据（本机实跑）

- 导出集合：旧 95 ↔ 新 95，missing=[] added=[]；type/value 分类逐名一致
  （`CurrentInterventionPackageReviewAudit` 仍是 V3 的 `export const` 别名，
  schema instance identity 经 `export ... from` 原样透出，无重复实例）。
- 语句级多重集合：旧文件每条非 import/注释行在新三文件并集中逐字节对应；
  仅差异 = 3 个内部缝定义获得 `export` 前缀 + 4 行 re-export 语句头。
- 无环：两内部模块均不可达 `intervention.ts`（BFS 实跑 false/false）；
  三文件之外无任何文件 import `intervention-review*`。
- 逐文件 import↔usage 精确匹配，无漏无赘。
- esbuild 0.28.2（arch-lead 既有 node_modules 的独立二进制，仅 parse 不解析依赖）：
  三文件 PARSE OK。
- advisory `biome check`（全局 2.5.7，仓 pin ^2.5.8）：0 error；1 warning 为
  原文件 :2040 已存在的同一 `useOptionalChain`（移动代码 :874），organize-imports
  已按仓规则整形。

## NOT_RUN（缺 node_modules，按禁令未 install）

`pnpm typecheck` / `pnpm lint`（仓内 biome 2.5.8）/ `pnpm build` /
`pnpm audit:*`：本树无 node_modules，全部 NOT_RUN；源码与静态证据已完成，
报父安排一次 frozen install 后补跑。本机/CI 测试按禁令未跑未改。

## 行数声明（不作为收益）

2268 → 990 + 919 + 456 = 2365（+97 行为三文件 header/import/re-export 管道）。
拆分理由是责任分离与修改局部性；行数本身不是收益证据。两新文件均未到
1500 行硬线，但这只是附带结果。
