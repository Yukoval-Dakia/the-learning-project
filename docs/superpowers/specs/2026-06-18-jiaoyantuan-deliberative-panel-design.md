# 教研团 · 多 agent 审议 panel + 更强规划 · 设计定稿

- **date**: 2026-06-18
- **status**: design（owner 要求重判 swarm + 让规划更强 + 实现方法的产出）
- **关系**: **supersedes** 早先「规划脑 = 单 prompt-step」（YUK-406 评论里的 Phase 2 规划升级为本 panel）；panel 宿主 = 关系脑 Phase 0 的夜间例会 job；本设计 = 规划的**生产侧**升级，不动 predicted_*/credit **结算侧**。
- **配套**: 愿景 `2026-06-18-private-teaching-research-team-vision.md`；坟场归档（swarm 条已标「重新审视」）。

> ⚠️ **2026-06-18 修正（YUK-416，DEFERRED）**：本文「mimo+Opus 模型异质 de-bias moat」+ cross-provider wrapper **已 defer**——mimo<<Opus、GLM 只 coding、唯 GPT 5.5 是 Opus 双强 peer 但未接 lane（异质 0.810 数据只适用能力相当双强）。**panel 现跑单 lane Opus + adversarial-role（魔鬼代言人）+ prompt-prior（A 巩固/B 前沿）+ SELECT-not-fuse**——团队感/防盲信价值不依赖异质且**更 SDK 原生**（同 provider 用 `Options.agents` map，不需 wrapper）；mimo 降为便宜 prompt-step。下文凡「异质 de-bias / 跨 provider」按此降级，重启条件见 YUK-416。

> **一句话裁决**：之前「团队感是体验层叙事、唯一真并行只有 Jury、规划折叠成单 prompt-step」**对了 ~80%，错的 20% 恰是规划**。「更强规划」=「真团队感」=**同一改动**：把规划升成有界/异质/judge-选择-非融合/单轮/默认折叠的审议 panel。

## 两条承重数据（已 web-verify）
- **Selection Bottleneck（[arXiv 2603.20324](https://arxiv.org/abs/2603.20324)）**：异质团队 + judge**选择** = win-rate **0.810**；同质 + 选择 = **0.512（近 chance）**；选择比 MoA-**融合**高 **+0.631**。→ **组长必须 SELECT 不是 average；A/B 必须真异质，否则选择也救不回来。**
- **Devil's Advocate（[IUI'24](https://dl.acm.org/doi/10.1145/3640543.3645199)）**：攻击 **AI 自己的推荐** → 准确率↑ **且 perceived workload 不显著增加** → 对抗审查是「免费提质」，不撞 engagement 红线。

## A. swarm 重判
- **coordination-swarm（多 agent 自由通信、多轮、拼一个输出）= 继续拒**（MAST 79% 失效在自由多轮协调；problem drift 76-89% 不可恢复；单人无 cohort 摊销）。
- **perspective-panel（真独立异质视角、不互通、分歧即产物、强 judge 选择收口）= 采纳**——这就是 swarm「有东西的那部分」，且 **Jury + 更强规划是同一 pattern**。
- 新增真 agent **仅 4 个**（教研员 A/B、魔鬼代言人、组长）+ 已有 Jury；**无任何两 agent 自由通信**（单轮 DAG、只读共享快照、judge 终结）——一刀切掉 MAST 79% 失效面。MAST 仍适用的三条编进设计：显式终止 / 主张挂 evidence_ref / 高风险断言独立 verify。

## B. 角色真实形态
| 角色 | 形态 | lane | 理由 |
|---|---|---|---|
| 教研组长 Synthesizer-Judge | 真 agent，**唯一 writer**，structured | anthropic-sub Opus | selection bottleneck 旋钮；**选**一份非融合 |
| 教研员 A 巩固派 | 真 agent | anthropic-sub Opus | 分歧左极；真异质=盲点不相关 |
| 教研员 B 前沿派 | 真 agent | mimo | 分歧右极；**A≠B provider 是硬要求**（同质=0.512） |
| 魔鬼代言人 Critic | 真 agent | 异于领先 plan | 攻**领先草案**（IUI'24）；无 evidence_ref 的 objection 自动 demote |
| 再归因 Jury | 真 agent（已存在）| 异质多模型 | `src/server/ai/judges/`，指向「规划」不重建 |
| 关系脑 / 日常 coach / 前台 copilot | prompt-step（coach 带一次 self-critique；前台保持单声音）| mimo | 无分歧可言 / 日常 panel 是浪费 / 多 agent 刷屏撞红线 |
| FSRS/due/去重/cooldown/预算/精确判分 | 确定性代码（零 token）| — | 纯算法，agent 化=theater |

**真像团队的三机制**：① 角色做可见地不同的事；② 分歧是真的（异质 provider，非换名牌——F6：同模型换名牌反伤 trust）；③ 分歧被 surface 但折叠（三层披露）。

## C. 规划 panel 机制（定稿）
```
A(Opus,巩固) ‖ B(mimo,前沿)  各读同一快照、互不可见、各产 markdown plan（脑内先 2-3 sketch 选最不同 = ToT-lite）
        → 魔鬼代言人(异lane) 攻 A/B 各列反例，每条挂 evidence_ref
        → 组长(Opus,structured) 选 A | B | 「A骨架+B某步」，禁融合 {chosen_plan_id, rationale, rejected_rationale, residual_risks}
        → verify(异lane) 仅高风险断言（引用/对 mastery_state 的事实）
        → 组长经 propose_* 落 proposal-as-event（唯一 writer）
```
**单轮、N=2**（多轮=problem drift+从众坍缩；同质饱和 N≈4；2 异质是性价比拐点）。
**诚实增益边界**：决策质量仅 **+1-5pp on 真分歧题，不承诺普涨**（MAD 文献证否「异质 debate 自动提质」）。真价值 = **分歧作为可下钻工件（团队感）+ 对抗审查防盲信**——落在 MAD 文献盲区（它们只测最终标量准确率，不测「过程作为产品」）。
**owner 仍在 judge 之上**；**predicted_*/credit/mastery 机器不变**（panel 只升产生侧，proposal 被采纳后才进结算侧）。

## D. 实现方法（可建）
- **编排 = blackboard SOP**（非 orchestrator-worker 15× token，非 handoff 链）：agent 经**结构化产物**通信非自由对话；blackboard 不必落新表（job 内存装配 evidence pack，phase 间闭包传，只最终 deliberation 落 proposal payload）。
- **挂 `coach_weekly.ts`**（周节律 + 闸门双重封顶成本），复用 `dreaming_nightly.ts` 骨架；日常 `coach_daily.ts` 保持单脑 + Reflexion-lite。
- **闸门（确定性、零 token、最强省钱旋钮）**：`B1↔练习冲突 / B3 结构变动 / 周期大改` 才触发 panel，否则单脑。默认偏紧。
- **lane 切换**：`runAgentTask(kind,input,{override:{provider,model}})`（`runner.ts:640/93`，`buildAgentEnv` 按 authMode 分支已存在 `:353`）；A=anthropic-sub Opus / B=mimo 默认。
- **成本**：~**3-4×**（非 15×，无递归扇出）且仅闸门触发（≤每周一次）；`PLANNING_PANEL_BUDGET.maxAgentCalls=4`；全进 `cost_ledger` 按 provider/phase 分账。**延迟非问题**（夜间 async；A/B `Promise.all` 并行）。
- **single-writer = 组长**（唯一 `propose_*`）；A/B/critic/verify 全程只读（allowlist `planning_panel` 零写）。
- 组长输出**复用 `src/server/ai/selection-orchestrator.ts` 的 parse**（brace-slice + Zod + `emitted⊆input`），天然锁「禁融合」。
- **OAuth lane 夜间挂** → 降级单 planner + 无 critic + `perspective_diversity:'degraded'` + UI 诚实「今晚单一视角」；**绝不假造分歧**（假分歧比无分歧更伤 trust）。
- **observability 零新基建**：每真 agent = 一条 `ai_task_runs`+`cost_ledger`+`tool_call_log`。新增仅 proposal payload 的 `deliberation`（turns/objections/chosen/run_refs/perspective_diversity）。
- **三层渐进披露**（反 wall-of-chatter 硬规格，F4 transparency-comprehension paradox）：Layer0 一句话 + **一个** dissent badge；Layer1 objection list + 标 model lane；Layer2 transcript + run_refs。**前台绝不实时 surface deliberation**。

## E. 裁决
**值得，但只值得有界版——而有界版就是研究指向的正确终态，不是妥协裁剪。完整 swarm 不是「更多」是「更差」。** Kill 掉：前台多 agent 刷屏 / 多轮辩论 / N>2 或掺弱模型凑多样性。

## F. 待 owner 决策（5）
1. 挂 `coach_weekly` 还是新建 `research_council_nightly`?（推荐挂 coach_weekly）
2. 闸门「B1↔练习冲突」的量化阈值（省钱旋钮，偏紧偏松是风险偏好）
3. per-run hard cap 的美元数 + warning 水位
4. A/B 的对立 prior 轴（默认「巩固 vs 前沿」，可换「广度 vs 深度」等）
5. 现在开 Linear Phase-2 epic（blocked-by YUK-365/B1/B3）还是等 B3 落地再开

## G. 最小切片 + alive/kill
**Slice**：① `PLANNING_PANEL_BUDGET` + `shouldRunPlanningPanel` 闸门；② 注册 `planning_panel`(md)/`planning_critic`(md)/`planning_judge`(structured Opus) + 只读 allowlist；③ `runPlanningPanel` 挂 `coach_weekly`（闸门→evidence pack→A‖B→critic→judge 落 proposal→verify）；④ deliberation payload + degrade 分支；⑤ 备课台三层披露；⑥ seam 测试（互不通信/组长禁融合/OAuth 挂降级/闸门偏紧/budget 硬顶/无-evidence objection demote）。
**ALIVE**（4-6 周）：你**真会点开 dissent badge** + 组长偶尔选 B 且**你因看了分歧改了主意** + 触发率落在真分歧周 + 成本在 cap。
**KILL/降级**：badge 从不点开 / A&B 几乎不真分歧（→退单脑省 3×）/ degrade 频发（OAuth 不稳，真异质前提塌）/ 触发失控烧钱。
**核心判据**：不靠「决策更准」存活（只 +1-5pp），靠「**你会看分歧、且分歧偶尔改变你的决策**」存活——后者才是 corrected constitutive bar 的真正兑现：一个会真分歧、记得你、不知疲倦的专家团，对一个人。
