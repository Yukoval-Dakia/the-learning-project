# PLAN — 活看板 (cockpit)

> 本项目的「手边」全局看板：比 `.remember/` 结构化、比 Linear 近手。**driver session 持续更新；收尾必同步**（见 `CLAUDE.md` →「Session Discipline · Cockpit & 全局视角」）。Linear 是**权威**驾驶舱（projects/issues 的真相），本文件是工作面镜像 + 当下决策态 + 在飞清单。四栏：NOW / NEXT / PARKED / BLOCKED-ON。**PLAN.md 是看板不是日志**：正文 ≤200 行、头部只留最新 1 条【更新】+ 更新于戳；超龄叙事段滚存归档、四栏就地改写对齐现实。
>
> 更新于：2026-07-25　·　历史头部日志（2026-06-23 ~ 07-22）已滚存 → `docs/planning/2026-07-07-plan-header-log-archive.md` 与 `.remember/today-*.md`；07-24 头部段 + 07-22 波次条目 → `.remember/today-2026-07-25.done.md`。

> **【更新 2026-07-25 · 收票日：18 PR 合并、16 票 Done、夜链成图、durable judge dark-ship】** 本 session（07-24 深夜~07-25）合并 #1056-#1064 / #1066-#1073 / #1075（#1065 关闭后重开为 #1069），main 头 `3f01d838`；Linear Done 16 张（YUK-770/769/768/765/763/608/562/444/230/229/758/594/775/782/761/781）。**承重四件**：① **YUK-758 夜间任务 DAG orchestrator**——27 只定时任务 14 只入图，manifest 声明 `dependsOn` + 单锚点 orchestrator 驱动、成员移除自身 cron（owner 拍板「直切」），调度态两表与 event 表物理隔离；合并前独立对抗审查（5 视角 refute-first、12 agent）抓到三轮 bot 都没抓到的必修项（tick 续链无保证 → 一次瞬时异常即整夜剩余节点静默不跑）。② **YUK-594 durable judge W1+W2**——`JUDGE_DURABLE_ENABLED` 默认 OFF 的 dark-ship，合并即上线但零行为变化，**翻 flag 有硬前置**（见 BLOCKED-ON）。③ **YUK-562+444 过程数据采集**——PfSolo 过程框（提交前折叠 opt-in）+ 1-5 信心自评（提交后判定前、可跳过、observe-only 绝不进 θ̂/FSRS/判分），后端 `reasoning_trace` 已通电到归因 prompt 两个 caller。④ **YUK-608 异源 solve/verify**——供给质量闸从「同模型自证」升级为异源验收。另：YUK-761+781 placement 清扫器与夜链锚点补跑通电；YUK-782 拔掉两次打红 CI（含一次打红 main）的时序 flake（改后覆盖更强：确定性 + 双向）。新立案 YUK-774/776/777/778/779/783/784，YUK-780 经代码核实**证伪后取消**（edge_propose barrier 自述不成立）。

## 🎯 主线方向（当前）

**方向 B = 诊断 payoff（owner 拍定 2026-06-23）。** 头号留存钩子 = 「看到我哪错/哪长」的学习者诊断档案（私人教研团终局）。两条主 project 仍是：① 领域模型重构 YUK-203 ② 学习者全面档案 YUK-452 / A1-A15。

## NOW（当前 active 线）

- **本 session 已收官**：18 PR 合并、16 票 Done，无代码 lane 待启动；权威主线 `3f01d838`。
- **在飞 2 个 PR 收最后一轮**（**未合**）：#1074（YUK-783，Biome 禁 capability UI 直取 contract-schemas barrel；mergeState=UNSTABLE，等 CI）· #1076（YUK-779，夜链静默空跑可见性 attempted vs succeeded；mergeState=DIRTY，**需 rebase**）。
- **下一 session 主 lane 候选**：YUK-777（High，durable judge 翻 flag 硬前置，做完才解锁判分主路径）→ YUK-778（High，夜链 DAG 次级加固）。小票继续走并行快通道（memory ticket-closure-pace：2-3 张并行、单轮评审、gate 绿即合、session 末报吞吐）。
- **UI 票不得硬塞**：YUK-774 / YUK-784 须先做 design-doc pre-flight 并等 owner 批准。

## NEXT（就绪，排队）

- **YUK-777（High）durable judge W3**：A 段 = 客户端幂等键 / record-unjudged-at-submit / domain-scan sweeper / DLQ 再入队；其中 `Tu71c` 是**真实数据丢失**，非理论风险。
- **YUK-778（High）夜链 DAG 三项次级加固**：tick 队列 retryDelay+DLQ / 日志可观测 / stale 标记空转。
- **YUK-776（Medium）placement 在飞态僵尸无兜底**：`queued/running/verifying` 投递消失后 `nonterminal_uq` 永久阻塞该 goal 后续 revision（YUK-761 范围外同类洞）。
- **YUK-774（Medium，须 UI pre-flight）**：DAG 运行态 admin 读面 + 「今晚图」可视化。**YUK-784（Low，须 UI pre-flight）**：过程框 + 信心自评扩到 PfPaper / PfStream。
- **D-ballot 剩余执行项**：YUK-771（D5 提议生命周期分批迁移）· YUK-772（D7 event actor_ref fail-closed 闸）· YUK-773（D8 typed client codegen，tripwire 已触发）——D3/YUK-770 本 session 已 Done。
- **YUK-751 effect-slice**（worktree agent-aa45ca5635aa08991，rebase-ready）：⚠️ 硬前置 = YUK-766 三道门**实施**（D4 已 ballot 选 (a)：checkpoint/delivery 进备份 + principal 类型层 + 幂等契约成文）。
- **07-23 拍板队列剩余**：YUK-437 / 679 / 757；测试跟进 YUK-764（608/229/230/562/594/444/758/765 均已 Done）。

## PARKED（已捕获，不是现在）

- **战略 non-ready queue（顺序/分类保真）**：epic/excluded = YUK-452；approval/new-carrier/excluded = YUK-680；NEEDS_DESIGN = YUK-747/448/522/750/753/752；OWNER_GATED = YUK-669/675/677；BLOCKED = YUK-596/748（等 YUK-747）/438（751 effect-slice 等 YUK-766）。07-25 出列：594/608/229/230/562/444/758 → Done。不得为凑 leaf wave 擅自升级 READY。
- **YUK-384 后续**：仅 rollout 与 YUK-746 hardening；不得回到已关闭未合并的 #1009 quick-fix 协议。
- **YUK-555**：hard-cap acceptance 未保真迁入 YUK-605 或命名 successor 前不得取消或改写。
- **研究板其余项目**：owner/product/scientific、design preflight、architecture/research、external/ops、data/statistics 与 large-program 六类继续 parked，见 backlog reconciliation 文档。

## BLOCKED-ON（在等什么）

- **`JUDGE_DURABLE_ENABLED` 翻 flag** ← **YUK-777 A 段全部完成**。W1+W2（#1068）已在 main，但默认 OFF、零行为变化；前置未清前翻 flag = 已知会丢判分数据，禁止。
- **多用户系决策（D1/D2/D6）** ← owner 主动缓行中（07-24 ballot：D3/D5/D7/D8 已立 YUK-770-773，D9 已执行）。
- **YUK-766 灾备恢复语义** ← effect-slice 硬前置（=D4）。
- **YUK-405 教研团两周窗** ← owner 本周上传内容。
- **YUK-669 owner gate**：历史清洗后的 secret scanning + push protection 仍须 owner/operator 在 GitHub 启用；不得把代码侧 containment 误写成此 gate 已完成。
- **YUK-590 / YUK-755 Linear metadata-only blocker**：两张 Done issue 仍带 accidental synthetic SLA `2099-12-31` / `all`。当前 Linear MCP 无法安全清除，环境无 Linear API token，尝试写 Linear comment 又因 wrapper 强制要求不兼容的 optional fields 而失败。operator 必须通过 Linear UI 或 authenticated raw GraphQL **同时清除** `slaBreachesAt` 与 `slaType`，且不得 reopen 两张 Done issue。
- **YUK-605 supply/ADR drift 批**：YUK-555 hard-cap acceptance 必须保真迁移后才可 conditional-cancel。
- **profile P2 / A9 step-grading**：仍分别等待 misconception/judge 数据校准证据。

## 在飞（PRs / workflows / worktrees）

- **开放 PR**：#1074（YUK-783，UNSTABLE 等 CI）· #1076（YUK-779，DIRTY 需 rebase）· 陈年 #1019（YUK-384 交付期 cockpit PR，已被此后多轮 cockpit 同步取代，**待核后关**）· Dependabot #1012-1016 沿旧口径未核。
- **权威主线**：origin/main@3f01d838（#1068 / YUK-594 W1+W2）。**部署注记仍有效**：生产 rollout 前需设 `JUDGE_PROVENANCE_SECRET`（openssl rand -hex 32，≠ INTERNAL_TOKEN）。
- **worktrees**：本 session 18 个 lane worktree 已随 PR 合并作废（另有 `yuk-594-w1w2-r3`、`yuk-229-ssrf-fix` 两个辅助 lane），全部待批量 `git worktree remove` + prune；仍活：agent-a9d3794f7df453cf6（yuk-783）· agent-a2da146e50c080770（yuk-779）· agent-aa45ca5635aa08991（effect-slice，等 YUK-766）。全仓另有 100+ 历史 worktree 长期未清（纯操作性杂务，不单开 Linear 票）。
- **主工作树**：owner-dirty（owner 本机工具配置），未 stage、未改写；本次收尾在隔离 worktree 完成。

## ✅ 最近已落（防遗落，下次别重做）

- **07-25 收票日**：18 PR / 16 票明细、四件承重交付的技术要点、新立案与 YUK-780 证伪过程 → `.remember/today-2026-07-25.done.md`。
- **07-24 迁移列车日**：16 PR 合并、0074-0078 迁移列车全落、D1-D9 owner ballot → `.remember/today-2026-07-24*.md`；审计报告 + 部署形态裁定见 `docs/audit/2026-07-24-coupling-multiuser-readiness.md`（registry.ts 1914 行 = 现头号 god file，D8 tripwire 已触发）。
- **07-22 实现波（YUK-590/742/745/755）+ grounding 排程**：全部 Done，明细留档 `.remember/today-2026-07-22.md`；仅 YUK-590/755 的 metadata-only SLA 清理仍待 operator（见 BLOCKED-ON）。
