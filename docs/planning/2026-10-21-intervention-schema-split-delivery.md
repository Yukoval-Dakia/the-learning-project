# YUK-1572 — intervention schema 三段拆分（交付记录）

候选 brief：`src/core/schema/intervention.ts`（2268 行）把三类职责叠在一个文件里：
业务构造契约、当前评审/审计绑定协议、历史持久化格式解码。本片按职责拆为三个模块，
公共 import 面 `@/core/schema/intervention` 与其全部 95 个导出（含 type/value 分类）不变。

## 元数据

- base：`ce74a7733f93044f55c0b00d056ae3c8d137f1fc`（fixed main）
- branch：`arch/intervention-schema-split`
- worktree：`/Users/yuqi/.t3/worktrees/the-learning-project/t3-7f2c17bf`
- head / diff hash / 校验输出原件：外部证据目录
  `tlp-audit-artifacts/architecture-deepening/YUK-1572/25fe0dedd6076cc95735e8eb3980ed8333d3a39c/intervention-schema/`

## 逐文件范围

| 文件 | 行数 | 内容 |
|---|---|---|
| `src/core/schema/intervention.ts` | 2268 → 990 | 业务构造契约与公开面组装：snapshot/recommendation/settlement/package/preparation/authoring 全部 schema、settlement 构造与 reanchor、确定性校验、reverse-causation 抽取、review requirements、task-input builder；尾部为公开 re-export 区 |
| `src/core/schema/intervention-review.ts` | 919（新） | 当前评审/审计协议：协议版本常量、failure code 词表、diagnostic kind、reverse-causation claim 上限与 schema、required-operation 检查与 `interventionRequiredOperationDigest`、独立解题/内容校验审计、V2/V3/Current 评审 audit 与全部当前绑定 refinement |
| `src/core/schema/intervention-review-history.ts` | 456（新） | 历史只读解码：Legacy model output 与 audit、早期 V2 / pre-operation-binding 历史形状、`InterventionPackageReviewAudit`/`ModelOutput` 版本宽容 union reader |

protected/其他文件：diff 仅含上表一改动 + 两新增；36 个消费者与全部测试逐 blob 无变
（`git status`/`git diff --stat` 证据封存外部目录）。

## 拆分边界与共享演进限制

本片按业务构造、评审绑定、历史解码组织代码，保持原行为和 schema 实例身份。
这三部分不是接受范围可独立演进的版本边界。撤回初稿中「当前严格化不波及历史」
及「另一模块只读依赖所以不受影响」的结论；该耦合在拆分前已经存在，本片未消除它。

以下行号固定于源码 head `25fe0dedd6076cc95735e8eb3980ed8333d3a39c`：

| 锚点 | 现状与变更影响 |
|---|---|
| `intervention-review-history.ts:89,116` → review 的 `InterventionPackageReviewRequiredOperationChecks`（review:243–246） | 历史分支复用当前检查对象；optional 只允许字段缺席，字段存在时仍受共享规则约束。收紧该对象会影响历史接受范围。 |
| history:391–397 → `InterventionPackageReviewAuditV2Fields`（review:670–679）与 `refineInterventionPackageReviewAuditBindings`（review:740–777） | 历史 V2 的字段与 task-run/digest 绑定检查共同演进，不能视为已冻结的历史副本。 |
| history:449–454 的 `InterventionPackageReviewAudit` | union 同时保留当前 V2/V3、历史 V2、pre-operation 和 Legacy 分支；当前分支变化也会影响这个持久化 reader。 |
| history:399–447 的 pre-operation 分支及 Legacy 定义 | 分支专有的旧字段缺省与 refinement 是应保留的兼容锚点；它们仍可引用共享类型/词表，不能笼统称整条旧分支完全冻结。 |
| `agency/server/intervention/store.ts:80–81` → `intervention.ts:845` → 上述 union | 真实生产 consumer 读取 `preparation_attempts_json`；规则变化必须核对存量记录接受范围，不仅核当前生成契约。 |

这里「共享且共同演进」描述现有依赖事实，不授权改变旧数据接受范围。
需冻结的兼容义务是现有旧形状、缺省和绑定规则；本片通过不改这些定义来保持它们，
并未建立独立版本快照。若后续要求真正的版本冻结，须单独按原权限裁定，
不得为证明本次拆分而复制 schema、放宽或收紧任何旧分支。

## 两个变化场景的影响表

| 场景 | 可能修改处 | 必须核对的影响与边界 |
|---|---|---|
| 新增一种历史持久化形状 | history 中新增专用分支及 union；仅当共享锚点无需变化时可限于此文件 | 核对 union 分支选择、既有旧形状和当前 V2/V3；真实入口为 store 的 preparation attempts reader。不能因分文件就宣称当前行为自动不受影响。 |
| 只收紧当前 operation/task-run 规则 | 若直接改 review 的共享 RequiredOperationChecks、AuditV2Fields 或 refinement，历史 V2 也会受影响 | 必须沿上表核历史与生产 reader。要求“只影响当前”时，现有布局不足以保证；需另行版本边界方案与裁定，本片不实施语义隔离。 |

## 五标准对账

1. **责任**：按业务构造、当前及共享绑定、历史解码组织；职责可辨，但规则存在明确共享耦合。
2. **接口**：公共 import 面与 95 个导出保留。24 个 value 转出逐站点分类仍待协调裁定，
   不能凭原公共面、文件仍有实现或实例相同自动豁免；未新增 registry 或自行批准 shim。
3. **隐藏知识**：外部 caller 原本就不知道内部版本实现，本片没有新增 caller 少知。
   分文件让历史分支与共享锚点更易定位，不等于历史接受范围与当前绑定隔离。
4. **修改局部性**：新增历史形状可能局部；共享绑定收紧必须核多个分支。
   不声称两个场景的编辑或审读范围必然减少。
5. **行为证据**：下述静态证据限于行为保持与结构；运行时门仍 NOT_RUN。

本次文案纠偏依据原 YUK-1572 评论
https://linear.app/yukoval-studios/issue/YUK-1572#comment-050998a7-f1a7-43de-bd43-c27193e53b42。
只改交付说明；源码、完整旧分支、schema 实例身份及接受范围均未改变。

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
拆分理由是代码职责组织与审读定位；修改局部性的限制见上表，行数本身不是收益证据。两新文件均未到
1500 行硬线，但这只是附带结果。
