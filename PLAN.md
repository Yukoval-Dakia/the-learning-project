# PLAN — 活看板 (cockpit)

> 本项目的「手边」全局看板：比 `.remember/` 结构化、比 Linear 近手。**driver session 持续更新；收尾必同步**（见 `CLAUDE.md` →「Session Discipline · Cockpit & 全局视角」）。Linear 是**权威**驾驶舱（projects/issues 的真相），本文件是工作面镜像 + 当下决策态 + 在飞清单。四栏：NOW / NEXT / PARKED / BLOCKED-ON。
>
> 更新于：2026-06-20

## 🎯 主线方向（当前）

**冷启可用优先（cold-start-first）。** owner 修正：(1) 产品没到能用 → 攒不了数据 →「dark-ship 等数据翻 flag」是空转；(2) profile/教研团必须 **day-one 靠先验可用**（新用户拿到就得能用），n=1 firm-up 是**精炼非前提**。见记忆 `feedback_cold_start_first`。代码体检结论：**引擎全活（FSRS/judge/mastery/copilot SSE），断点全在 wiring**。

**待 owner 拍的关键 fork**：每天打开它的钩子 = 「记+练+复习」机械闭环 vs 「看到我哪错/哪长」诊断 payoff？→ 决定 profile 冷启设计是否前置。

## NOW（在推的一条线）

- ✅ 三个输入齐了，全汇合到同一结论 **「缺的是 day-one 入口」**：代码体检（loop wiring 真相）+ 冷启外部研究（`wl8czd2vc`）+ 冷启设计 doc（`docs/design/2026-06-20-cold-start-day-one-design.md`）+ UI 完全体 gap 分析（claude design fa5b0bb6）。
- **UI 完全体覆盖稳态 app + A1-A8 + 空/错态几乎无懈**；唯一承重缺口 = **新用户冷启首会流（onboarding→goal→placement→起始档案）完全 ABSENT**——冷 DB 落空 /today。UI gap 与代码 gap 完全对齐。
- **冷启 n=1-safe 栈**：KG 结构剪空间 → LLM **模拟/比较式** elicit b（绝不 1-10 直评）→ EAP/AutoElicit 带方差 θ/p(L) 先验 → 1PL placement 探针收敛 → FSRS 默认参数 + judge 锚答案+约束 taxonomy 归因。**从不估** a/c/slip/guess。诚实警告：LLM 难度只 moderate（best ρ~0.43-0.50、系统低估）→ 靠 owner anchor 题校 offset + 宽方差 + 可见不确定性；misconception conjecture 最弱（目录靠 subject 声明、归因靠 live judge）；强模型反而模拟学生更差。
- **inc 序（设计 doc §5）**：inc-A owner fixed-anchor 写路径（**最高杠杆**，`source='fixed_anchor'` 槽已存无 writer，纯 add）→ inc-C onboarding/goal 入口（UI，需 pre-flight）→ inc-B placement 探针（flag，cold-DB only）→ inc-E prereq mastery 传播（重，flag+审计）→ inc-D AutoElicit / inc-F 模拟 elicit。
- **待 owner**：设计 doc §6 的 7 个问题（见下）+ 钩子 fork（机械闭环 vs 诊断 payoff）。

## NEXT（就绪，排队）

- **loop-wiring 关键路径**（让机械闭环马上能用，全是接线、引擎已活）：
  - Step1 [HARD] `/mistakes` 路由 + 最小 `MistakesPage`（`GET /api/mistakes` 已返回、CSS 已在、RecordPage 已 navigate 它）
  - Step2 [HARD] 练习流加「never-attempted active 题」source（`stream-store.ts:96` `collectComposerInputs`，不 gate 在历史）
  - Step3 [HARD]「练这道题」门（`startSolveSession` client 已在 `practice-api.ts:329` 但无 caller，接上）
  - Step4 [polish] 死 Copilot CTA（`TodayPage.tsx:231`）+ router `notFoundComponent` + `/mistakes` 文案
  - Step5 [polish] `pnpm up` 一命令冷启 + 修 `smoke-local.ts` 死端口
- **profile/教研团 冷启 prior 设计**（研究回来后据外部模式落地）

## PARKED（已捕获，不是现在）

- **活 bug**：YUK-358 Decision1 — `apply-note-patch.ts:67-110` 无 user_verified guard，AI 可经 replace/delete_block **静默覆写用户已验证的笔记块**（propose-only 红线，~0.5-1 天）。
- **Linear 卫生**（审计 `w8iz32mse`，待 owner 批）：close YUK-303/306（已验证 done）、YUK-373/375/360 移出 In Progress、YUK-397/310 重写 scope。
- **C7-C10 matcher cleanup**：折入 YUK-397，随 inc-5 / live-caller（C7 cosine 标定 data-gated / C8 cause→JobData / C9 verifyEventId 直返 / C10 promote-FSRS 去重）。
- Step6 [ops] NAS always-on 部署（`TUNNEL_TOKEN` + compose up，运维决策）。

## BLOCKED-ON（在等什么 — 冷启修正后多为「需先验」非「纯等数据」）

- **profile P2 翻 flag**（misconceptionRecurrence / B4 answer_class filter）← 需 ① 真实 attempt 数据 ② **冷启 prior 设计**（不是纯等数据）+ B4 seeded 验证 + misconceptionRecurrence N+1 批处理 `TODO(flag-on)`。
- **matcher 接 live caller** ← 题库规模 + Step2 feeder 验证（小题库 cosine 无意义）。
- **教研团 YUK-405 / 记忆 YUK-322** ← profile 有真实数据 / 交互历史。
- **A9 step-grading 倍增器** ← gated B5 / YUK-350 judge 校准。
- **D4 RT1 misconception 图节点**（渲染「指向此点的误区」）← gated YUK-344 一致性闸。

## 在飞（PRs / workflows / worktrees）

- workflow `wl8czd2vc`（冷启研究）运行中。
- `main` @ `ba2b523f`；无 open PR（P2 第一批 A3/D2/B4 + ci-gate docs-skip 全 merged）。
- 本看板分支：`yuk-cockpit-discipline`（PLAN.md + CLAUDE.md 纪律）。

## ✅ 本 session 已落（防遗落，下次别重做）

- P2 第一批 merged：A3 answer-class 写时填（YUK-395 Done）· D2 misconceptionRecurrence 软信号 · B4 #506 matcher answer_class hard-filter（全 dark-ship）。
- YUK-400 Done（A 段 YUK-401 + B 段 YUK-402 blocker 清；matcher 可安全接 live caller）。
- ci-gate docs-only skip（#504）；git main 理顺（OCR commit `ba2b523f` 保留进 origin）。
- 战略拐点：usability-first + cold-start（记忆 `feedback_cold_start_first`）。
