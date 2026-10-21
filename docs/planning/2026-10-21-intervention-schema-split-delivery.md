# YUK-1572 — intervention schema 三段拆分（交付记录）

候选 brief：`src/core/schema/intervention.ts`（2268 行）把三类职责叠在一个文件里：
业务构造契约、当前评审/审计绑定协议、历史持久化格式解码。本片按职责拆为三个模块；
公共 import 面 `@/core/schema/intervention` 按协调批准收窄为 82 个导出（51 value + 31 type）。

## 元数据

- base：`ce74a7733f93044f55c0b00d056ae3c8d137f1fc`；已普通 merge 最新 main `67506c5ea`
- branch：`arch/intervention-schema-split`
- worktree：`/Users/yuqi/.t3/worktrees/the-learning-project/t3-7f2c17bf`
- 批准：YUK-1572 comment `c07e26a1-af2e-4d06-8faf-8b796635fa00`
  （A11 stable_contract 逐条登记 + B13 旧 value 名收窄）；裁定事实基线 proposal SHA256
  `d7460ab6008d464e6cfbf3ca2cf77665a2394e17750caace3d184c77fa3c2eaa`
- head / diff hash / 校验输出原件：外部证据目录
  `tlp-audit-artifacts/architecture-deepening/YUK-1572/<head>/intervention-schema/`

## 逐文件范围

| 文件 | 行数 | 内容 |
|---|---|---|
| `src/core/schema/intervention.ts` | 2268 → 975 | 业务构造契约与公开面组装：snapshot/recommendation/settlement/package/preparation/authoring 全部 schema、settlement 构造与 reanchor、确定性校验、reverse-causation 抽取、review requirements、task-input builder；尾部为批准收窄后的公开 re-export 区 |
| `src/core/schema/intervention-review.ts` | 919（新） | 当前评审/审计协议：协议版本常量、failure code 词表、diagnostic kind、reverse-causation claim 上限与 schema、required-operation 检查与 `interventionRequiredOperationDigest`、独立解题/内容校验审计、V2/V3/Current 评审 audit 与全部当前绑定 refinement |
| `src/core/schema/intervention-review-history.ts` | 456（新） | 历史只读解码：Legacy model output 与 audit、早期 V2 / pre-operation-binding 历史形状、`InterventionPackageReviewAudit`/`ModelOutput` 版本宽容 union reader |
| `src/capabilities/agency/server/intervention/contracts.ts` | −2 行 | 删 `InterventionPackageReviewAudit`/`InterventionPackageReviewModelOutput` 两个无终端消费者的死 value 再导出（批准收窄项）；其余 12 type + 12 value 透出不动 |
| `scripts/capability-boundary-baseline.json` | +11 条 | `changes` 尾部追加 11 条 `stable_contract` ruling（site 级、逐符号、含真实 consumer 起始行）；不覆盖上游前缀 |

protected/其他文件：diff 仅含上表范围 + merge；36 个消费者与全部测试除上述 contracts.ts
两行批准删除外逐 blob 无变（`git status`/`git diff --stat` 证据封存外部目录）。

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
2. **接口**：公共面 95 → 82（51 value + 31 type）。11 个有终端消费者的 value 透出
   已按批准逐条登记 `stable_contract` ruling；13 个无终端消费者的旧 value 名按批准
   收窄（仅删 re-export 与 contracts.ts 两处死透出，真身/union 臂/Current alias/全部
   type 出口不动）；无 registry、白名单或 `*`。
3. **隐藏知识**：外部 caller 原本就不知道内部版本实现，本片没有新增 caller 少知。
   分文件让历史分支与共享锚点更易定位，不等于历史接受范围与当前绑定隔离。
4. **修改局部性**：新增历史形状可能局部；共享绑定收紧必须核多个分支。
   不声称两个场景的编辑或审读范围必然减少。
5. **行为证据**：下述静态证据限于行为保持与结构；运行时门仍 NOT_RUN。

本次文案纠偏依据原 YUK-1572 评论
https://linear.app/yukoval-studios/issue/YUK-1572#comment-050998a7-f1a7-43de-bd43-c27193e53b42。
只改交付说明；源码、完整旧分支、schema 实例身份及接受范围均未改变。

## 行为保持证据（本机实跑）

- 导出集合：旧 95 → 新 82，removed 恰为批准的 13 个旧 value 名，added=[]；
  其余符号 type/value 分类逐名一致（`CurrentInterventionPackageReviewAudit`
  仍是 V3 的 `export const` 别名，透出转发同一 live binding，无重复实例）。
- 语句级多重集合：旧文件每条非 import/注释行在新三文件并集中逐字节对应；
  除 re-export 语句头的符号增减外，仅差异 = 3 个内部缝定义获得 `export` 前缀。
- 无环：两内部模块均不可达 `intervention.ts`（BFS 实跑 false/false）；
  三文件之外无任何文件 import `intervention-review*`。
- 消费者闭包：36 个引用文件的全部 named import/re-export 仍解析（13 个被删名
  在全部通道零终端消费，contracts.ts 两死透出已删；逐项通道核对非 grep 空代证）。
- 逐文件 import↔usage 精确匹配，无漏无赘。
- esbuild 0.28.2（arch-lead 既有 node_modules 的独立二进制，仅 parse 不解析依赖）：
  四文件 PARSE OK。
- advisory `biome check`（全局 2.5.7，仓 pin ^2.5.8）：0 error；1 warning 为
  原文件 :2040 已存在的同一 `useOptionalChain`（移动代码 :874），organize-imports
  已按仓规则整形。

## 机器实跑（父完成 frozen install 后，heavy.sh 单 lane 串行）

父 frozen install receipt：`parent-frozen-install.json`（rc=0，log SHA
`03a596b7…594`，package/lock/workspace 前后哈希不变）。以下门均经
`heavy.sh`（全机 2 槽）串行实跑，argv/UTC/原始 stdout/stderr/真实 rc
封存 `…/<head>/intervention-schema/gates/`：

| 门 | argv | rc |
|---|---|---|
| typecheck | `pnpm typecheck`（tsc --noEmit + server/start tsconfig） | 0 |
| lint | `pnpm lint`（仓内 biome 2.5.8 `biome check .`） | 0 |
| build | `pnpm build`（web+start+server+worker+migrate） | 0 |
| audit:capability-boundaries | `pnpm audit:capability-boundaries` | 0 |
| audit:architecture-deepening | `pnpm audit:architecture-deepening --base 20222f2cafe1500a9e445b43fe132935405d825a` | 0 |

scanner 实测原文：`pass-through sites 1097 (+11 new)`——恰为本片 11 条已登记
`stable_contract` site 全覆盖，无未分类违规；`dependency totals 403/0/37`
与 ratchet 精确一致，`new dependency edges=0`。**尺寸下降披露**：
`>1500-line files=12 (base 13)`——本片使 intervention.ts 退出该档；
此为实测量，不自行放宽门，交父登记。tests/DB/runtime/provider 按禁令未跑未改。

## main 整合核验（R1 APPROVE 后，无新增审查）

- 普通 merge `origin/main@67506c5e`（YUK-1570 json 算法入 core）；
  `20222f2ca` 已为此前 merge 前缀，上游账本完整保留。
- 唯一冲突 `capability-boundary-baseline.json`（双方尾追加 `changes`）：
  按并集解——main 全部段（`debts` server 394、`edgeRecords`、
  `sourceSizeRecords`、`compatShims`、上游新增 changes）逐字节保留 +
  本片 11 条 stable_contract 原记录追加；全文件 `git diff origin/main`
  仅 +252/-0。
- 已审 source 等价：merge 后 `intervention.ts` / `intervention-review.ts` /
  `intervention-review-history.ts` / `contracts.ts` 与 R1 所审
  `bc4ffb5ac` blob 逐字节相同（sha256 对验），31 types / union 臂顺序 /
  Current alias / 实例 identity 均未动；本 doc 随整合更新，不能称其 blob 未变。
  上游 json core 两文件与 9 个 consumer 的 import 改指完整保留。
- 机械修复披露：上游 Biome 重排把 `recommend.ts` / `intervention-author.ts`
  的 intervention import 起始行 2→3 / 6→7，致我 11 条记录的 consumer
  `line` 证据失实（audit 11 violations，非语义 finding）。仅改 ledger 内
  该 11 处行号，site/symbol/consumer 不变；修复后 audit rc=0。
- 整合后重跑 5 门全绿（heavy.sh 串行）：typecheck 0 / lint 0 / build 0 /
  boundaries 0（`394/0/37` 精确）/ architecture 0（`+11 new` 仍全覆盖）。
  receipt 与 raw 存 `…/<final-head>/intervention-schema/gates/`。
- R1 过程披露补遗：作者报告首轮 boundaries runner 终端状态为 143；
  该次 partial raw 未独立封存，作者说明随后重跑截断覆盖，记为 NOT_CAPTURED。
  因缺原始回执，父未独立核定该次状态、终止信号或原因，不称 SIGKILL。
  后续有效 run 的 receipt 与 raw 独立保留，不补造首次日志。

## 行数声明（不作为收益）

2268 → 975 + 919 + 456 = 2350（+82 行为三文件 header/import/re-export 管道）。
拆分理由是代码职责组织与审读定位；修改局部性的限制见上表，行数本身不是收益证据。两新文件均未到
1500 行硬线，但这只是附带结果。
