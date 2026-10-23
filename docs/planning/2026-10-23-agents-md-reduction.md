# AGENTS.md 大幅缩减记录（YUK-1649，2026-10-23）

> Owner 2026-10-23 指示大幅缩减 AGENTS.md。本 doc 是唯一归档：被移除/压缩条文的原文与去向逐段列明，零信息丢失。缩减前基线：origin/main `12cb65eed` 的 `AGENTS.md`（258 行）→ 缩减后 ~100 行。

## 动机（2026-10-23 协作效率审计实测）

- 每个 Codex rollout 平均注入 281K uncached tokens，AGENTS.md 全文是固定开销；4 天 423 个 rollout。
- 四块测试规则（2026-10-10 默认不写 / 10-11 禁止细小 / 10-12 Owner rules / audit 准入）语义重叠，agent 需自行调和。
- PLAN.md/.remember 本地化规则在文中重复三处；YUK-1388 阶段码表等单票细节长期内嵌。

## 迁移表

| 原段落（原行号） | 处置 | 去向 |
|---|---|---|
| Header（1-5） | 压缩 + 加缩减说明 | 保留在新文件头部 |
| Owner rules 2026-10-12（7-16） | 与 10-10/10-11 测试规则合并为一条「测试默认不写、写入须批准」，并新增机械更新模式预批口径 | 新文件 Owner rules 第 1 条；原文见下方归档 A |
| Scope discipline（18-25） | 全保留，措辞压缩 | 新文件 Scope and delivery |
| Delivery stages / anti-slop YUK-1388（27-47） | 阶段码表与外置 artifact 绝对路径移除；行为规则（live consumer、S13 含禁止扩展、阶段外工作限制、新旧路径、pre-AI 八项、样本量）保留压缩 | 新文件 Scope and delivery；阶段码表原文见归档 B |
| Session and collaboration discipline（49-71） | PLAN/now 规则去重为一处；subagent 角色路由压缩为两句；session-start 核票与单 active 线保留（R1 修复恢复） | 新文件 Session discipline；角色路由原文见归档 C |
| UI design pre-flight（73-82） | 压缩为 Planning 段一条 | 新文件 Planning 末；全文见归档 D |
| Runtime and architecture（84-108） | 全部边界保留，15 bullets 压为 6 条 | 新文件 Architecture boundaries |
| No-regression checklist YUK-1579（110-125） | 六项全保留（含④调用方不得重写内部排序/决策，R1 修复恢复），压为一段 | 新文件 Architecture boundaries 末条 |
| Development and verification（127-185） | 命令与硬约束保留；四块测试规则合并进 Owner rules；细则归档 | 新文件 Development and verification；测试三块原文见归档 A |
| Planning and documentation（187-202） | 批量证据外置规则压缩保留（含 git 历史不重写，R1 修复恢复）；PLAN/now 去重 | 新文件 Planning, docs, and tracking |
| Linear issue tracking（204-215） | 全保留压缩 | 同上 |
| Code search（217-224） | 压为一条 | 同上 |
| Tooling and settings（226-233） | 压为一条（含用户级 Claude settings 受保护时给精确 diff，R1 修复恢复） | 同上 |
| Deployment（235-237） | 压为一条 | 同上 |
| Review, merge, and delivery（239-258） | 保留无等待窗（10-21）与预算；新增 Review 分级（Tier A/B）与栈深 ≤3、rebase 去委派化 | 新文件 Review, merge, and delivery |

## 新增条文（2026-10-23 owner 批准，本轮审计整改）

1. **微委派禁令**：单文件/单字面量/单条状态查询不 spawn 子 agent（审计实测：feat-yuk-1358 4 天 119 个单 turn 零工具 rollout，平均 281K uncached tokens/次）。
2. **Review 分级**：替代 memory 中「每 PR 五 lane」的全量要求——Tier A（core/schema/鉴权/ai/quota/worker/>500 行）多 lane；Tier B 一轮独立初审 + CI Gate。全量五 lane 的旧口径自本条生效起作废。
3. **栈深 ≤3 + rebase 去委派化**：审计实测 `Rebase #1775 R8`（第 8 轮 rebase 委派任务）；main median 12 分钟一动，追逐循环是协议性的。
4. **测试机械更新模式预批**：对既有已批测试文件的计数/快照/改名类机械更新不再逐次上浮 owner（审计实测：#1752 因「订阅清单 5→6」测试方案审批卡 3 天，同类上浮 66/263）。
5. **协调线随 stage 退役**：审计实测三条常驻协调线 121/164/42MB transcript、50/42 次 compaction。

## 归档 A — 测试规则原文（10-12 Owner rules §1-2 + Development 148-185）

以下为基线 `12cb65eed` 的逐字抽取（行号标注于标题）。原 148-149 行的引导句（指向 development-workflow.md 与 Owner rules 约束）保留在正文 Development 段，不在归档重复。

> - **禁止未经 owner 批准编写测试代码。** 如需新增或修改测试，先只写文本方案，
>   等 owner 后续明确批准该方案后才能写测试代码；旧计划、skill 或子任务要求不算批准。
> - **测试永不阻塞开发。** 不把测试的编写、运行、等待或通过作为开发前置或阻塞项；
>   如实记录未验证范围。本文及其他项目文档中冲突的旧测试要求以本节为准。
>
> - **默认不写测试（owner 2026-10-10，YUK-1401）。** 只有改动触及下列不变量时才写或
>   更新测试，且断言必须在该不变量被破坏时真的失败：
>   1. 数据不可逆：迁移、备份恢复不丢列、删除/合并不丢数据；
>   2. 判分与结算的确定性：同输入同分数/同状态，含数值核心与 TS↔Rust parity；
>   3. 并发与锁：advisory lock、CAS/版本冲突、事务回滚与幂等重试；
>   4. 安全边界：`/api/*` 鉴权与豁免、浏览器不持 provider key、授权与第三方信息不外泄；
>   5. 危机转介（YUK-1398）。
> - 五类不变量优先于下面的排除项：helper、DTO、UI 行为若承载上述不变量（如确定性
>   判分、幂等、隐私隔离），仍按不变量写测试（从哪进入见下条）。除此之外不写：只验证 UI/组件渲染、
>   DTO/schema 形状、prompt/文案/快照/字节 hash、源码路径与文档结构、实现细节，或只断言
>   “被调用/存在”的测试，以及为覆盖率补的测试。
>   修 bug 时若不触及上面五类，用 typecheck/build 和真实运行验证，不补回归测试。
> - **禁止细小测试（owner 2026-10-11）。** 五类不变量决定*要不要*写，本条决定*从哪
>   进入*：承载不变量的 helper 也经最近的真实边界或其模块公开入口测，不单测 helper。
>   真实边界指 route、job、DB 事务（含在真实 Postgres 上跑的锁/CAS/幂等原语）、
>   结算/判分链、agent 工具契约，或确定性核心模块的公开入口（模块 index 导出的函数；
>   TS↔Rust parity 套件算公开入口）。一个不变量一条 case；表驱动算一条；分支或边界值
>   只有删掉它会放过一个别的 case 抓不到的具体缺陷时才另写（`@fails-if` 须写明该缺陷）。
>   禁止：内部 helper 单测、同一路径参数排列、断言 mock 交互或调用次数。mock 只替
>   外部依赖（provider、网络、时钟、blob 存储）；依赖 DB 的不变量放 DB 测试分区用真实 PG。
> - **测试多于代码须说明。** 一个 PR 新增测试行（含 fixture）超过新增产品代码行
>   （`src/**`、`server/**`、`web/**`、`scripts/**` 非测试文件与 migration SQL）时，PR 描述须
>   逐个不变量说明；这是说明触发线不是硬上限，说明不了的删掉。独立审查必须核对。
> - 新增或修改 case 的准入由 `pnpm audit:test-policy` 在 CI 强制执行；须在该 case
>   前声明 `@invariant` 类别/保护结果及 `@fails-if` 具体缺陷。格式和审查要求见
>   `docs/agents/development-workflow.md` 的 Test admission。标签本身不构成正确性证明。

## 归档 B — YUK-1388 阶段码表原文（原 29-37）

> - 对 owner 的交付文本用成果名，不用 W0/W1、I05、M073 等内部代码；票号可随后作参考。
>   阶段与内部波次对应如下：
>   - 第一天能用（W0）
>   - 帮助靠谱（W1）
>   - 按真实时间安排（W2）
>   - 说清不知道并检验（W3）
>   - 证明有效（W4）
> - 交付顺序与验收以 Linear 票及仓库外绝对路径 artifact 为准：
>   `/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/yuk1388/stage4/I02/waves-v1.md`。

## 归档 C — subagent 角色路由原文（原 63-68）

> - 创建 subagent 时按当前工具**已注册**角色与任务性质分流：实施路径和验收已定的
>   机械修改给 Fixer；目标明确但需本地调查、局部方案或调试的非 UI 实施给
>   Implementer；UI 交互与视觉给 Designer；高风险架构决策和独立复核给 Oracle。
>   角色不可用时由编排者先收敛任务，再交给可用执行者；同一 diff 不派两个写入者。
> - 具体模型、variant 和请求故障回退由当前工具配置决定；代码质量不达标须重新
>   判断任务与角色，不把模型 fallback 当作质量升级。

## 归档 D — UI design pre-flight 全文（原 73-82）

> ## UI design pre-flight
> 
> 2026-10-07 owner 持续委托见 [自主交付授权](docs/planning/2026-10-07-autonomous-delivery-charter.md)。本委托范围内，agent 在实施前记录以下 pre-flight 并承担方案与验收责任，不再等待 owner 逐项批准；owner 后续限制优先。未获此委托的工作仍须先提交并等待批准：
> 
> 1. 逐字引用相关 design doc，给路径与行号/章节。
> 2. 声明组件类型：drawer / route / modal / page / other。
> 3. 列出将创建和修改的文件。
> 
> 纯文档、纯后端、纯 schema、纯测试或已批准 plan 的实施步骤不适用。批准后仍须
> 遵循现有 design tokens、primitives 与 design-system 规则。

## R1 审查修复记录（2026-10-23）

独立 R1（codex/gpt-6.1-sol，NO-GO 3×P2）逐条修复：①YUK-1579 ④恢复「调用方不得重写被依赖模块的内部排序或决策」；②恢复四条漏迁规则（阶段外工作限制+S13 禁止扩展、session-start 核票与单 active 线、git 历史不重写、用户级 settings 精确 diff）并修正迁移表；③归档 A-D 改为基线逐字抽取（脚本按行号从 `12cb65eed` 抽取，补齐冲突优先条款与「标签本身不构成正确性证明」等遗漏）。
