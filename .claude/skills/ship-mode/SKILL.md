---
name: ship-mode
description: 目标路由 + 证据契约执行模式。给一个带可验证完成条件的目标（无 spec）时用：bug report 修复、新功能、perf、无人值守 long run、要求 ship/闭环 的任务。Use when user says "ship", "/ship", "ship-mode", "全自动", "闭环修掉", "overnight", hands a bug report to fix end-to-end, or a goal with a checkable done condition but no spec.
---

# Ship Mode

Ported from pstack `poteto-mode`（`.slim/clonedeps/repos/cursor__plugins/pstack/`）。路由层：把"目标 + 可验证完成条件"映射到一个 playbook，playbook 步骤逐字进 todo list，委派走本仓库 AGENTS.md 已注册角色。

## 不做的事

- ❌ 重复 launch-phase / diagnosing-bugs / tdd / pr / worktrees 已有的机制 —— playbook 步骤调用它们，不复制。
- ❌ "它编译过了"/"我改完了" 当证据。每条声明同句带证据：命令输出、`file:line`、commit SHA 或 artifact 路径。
- ❌ wrong-surface / INCONCLUSIVE 当通过。验证必须打在任务实际影响的面上，见 `verify-app` skill。
- ❌ CI 绿 / bot approve 当 verdict。行为改动的 landable verdict 必须来自没写这段代码的独立 verifier（`live-ui-verified`/`unit-test-verified`）；`type-check-only`/`verifier-blocked` 不可 land。verdict 按 `PR+headSHA` 记 ledger（`.omc/ship-engine/ledger.tsv`），head 变了 verdict 作废；同 patch-id 的 head 移动可复用 verdict。
- ❌ 不可逆操作无人值守执行：force-push、生产数据写、对外发消息、merge/deploy 之外的目标外操作一律停下问 owner。merge/deploy 按 AGENTS.md 已授权政策执行。

## 步骤

1. **选 playbook**（下表）。判断不了 → 问用户，不猜。
2. **开 todo list**：前 N 条 = playbook 步骤逐字复制，之后才加任务特定 todo。跳过的步骤保留并标 `skip: <reason>`，不许静默删。
3. **逐步执行**：写代码委派 writer lane 时 prompt 必须含 named scope + 成功标准 + **必须交付的 artifact**。read-only 验证委派 explorer/librarian。
4. **回复契约**：每条声明同句带证据或标 INCONCLUSIVE。child 的产出由 parent 亲自验（看 diff、重跑验证），不传递 child 自报。

## Playbooks

### bug-fix — bug report → 修复 → PR

适用：缺陷报告、错误行为、回归。配 `diagnosing-bugs` skill 做根因 loop。

1. 在匹配面上**亲自复现**，用 `verify-app`（UI → playwright 真驱动 :5173；API → 真调 :8787 带 `x-internal-token`；job → 真 worker）。复现不了就合成触发条件、收紧条件或插桩，直到打出来；只有控制面确实够不到目标时才问用户，并说明具体原因。
2. 二分根因。列候选假设，每轮取能砍掉最多剩余空间的那刀，拿 runtime 证据排除。codegraph_explore 定位符号；程序状态不明时加日志读运行态。不猜。确认的必须是**机制**，不是相关性。
3. 定修复方案。跨函数边界 → 先 oracle 设计复核；委派实施给 implementer/fixer，prompt 给 named scope（文件路径 + 数据形状 + 成功标准 + 必交 artifact）。
4. **同一面上验证**：原始 repro 现在通过。wrong-surface / inconclusive 不算过，显式标注。单测绿只说明分支行为，不说明 bug 消失。
5. commit 排序让失败 repro 先于修复落在历史里（有廉价单测路径时按 `tdd` skill 红-绿节奏；测试代价高/集成重时跳过并标 `skip: <reason>`）。
6. 按 `pr` skill 开 PR，body 里贴复现输出（修复前失败 → 修复后通过 verbatim）。

### feature — 新行为/改动行为

1. codegraph_explore + explorer 摸清受影响子系统。
2. 形状有争议 → oracle 出设计 sketch；有多种合法形状（错误处理、抽象层、测试结构）时可选 arena：两个候选并行产出，parent 读全部后选基底手动嫁接。
3. throughput checkpoint 写成 4 条 todo（不适用的维度标 `n/a: <reason>` 不删）：
   - **Blocking first steps**：必须先跑的 gate 排在 fan-out 前。
   - **Independent workstreams**：文件/服务/层不相交才并行；写重叠必须串行。
   - **Shared mutable state**：默认先拆目标而不是串行化（separate-before-serializing）。
   - **Smallest safe decomposition**：如果单 worker 最优，说明为什么。
4. 委派写码：named scope + 数据形状（domain 模型先定：判别联合/状态机/注册表，在 delegate 写逻辑前选好）+ 成功标准 + 必交 artifact。schema/route/job 改动走 `src/capabilities/<name>/manifest.ts` 组合根，改动 API route 同步 `postman/api-endpoints.json` + `pnpm gen:postman`。
5. 匹配面验证（verify-app）。inconclusive 不算过。
6. sequence-verifiable-units：小步提交，每个 unit 验证过才进下一个。
7. 设计有争议 → oracle review 再 ship。
8. `pr` skill 开 PR；merge 等 exact-head CI Gate 绿 + 无未裁决 P0/P1（AGENTS.md 政策）。

### perf — 有实测的慢

1. 用 `verify-app` 的匹配面抓 baseline trace（真实数字 + artifact 路径落盘）。
2. 假设先落地再动手；没跑过不许声称 perf ceiling。
3. 修 → 抓 post-fix trace → parse 对比（JSON/diff），cite delta 进 PR。inconclusive 不算过。

### overnight / long-run — 无人值守迭代

适用：用户给 goal + binary finish predicate + 授权范围，要挂着跑。

启动前必须齐（缺一即问）：
- **goal** + **finish predicate**（可机器判定的二值条件，不用时间上限）
- **worktree**（`worktrees` skill 建隔离 lane，prompt 约束所有 bash 只在 worktree 内）
- **worklog**（`worklog` skill，一行一决策一证据指针）
- **escape hatch**（什么情况停下问人）

Loop：一个改动 → 一次真实检查 → 一行 worklog。unit 红不前进；没用的改动丢弃不留；不许放松 finish predicate。可逆操作自主推进并展示结果；不可逆（push 外、对外消息、schema drop 类）一律停。

### multi-lane — phase spec / 多 deliverable

→ `launch-phase` skill，不在这里重实现。

## 回复格式

完成时输出：结果一句话 + 证据表（claim → artifact/command output）+ 未完成项及其证据状态。不输出过程叙事。
