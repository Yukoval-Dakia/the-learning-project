# YUK-361 Phase 3 — 随机化 MFI 选题（档2 LLM-strong）实施计划

> 权威设计：ADR-0042 §1/§2 + **2026-06-15 编排档2 amendment**（`docs/adr/0042-...md:46-68`）。
> roadmap：`2026-06-15-personalized-calibration-roadmap.md` Task 7/8/9。本文是 grounded-in-code 的落地计划（Map 阶段产出收口）。

## 这是整条选题线的第一个**真行为变更**

Phase 1/2（观测先行）零行为变更。Phase 3 把 LLM 权重 → sampler → π_i 真正接进选题路径，**改变 owner 每日看到的非到期题选择**。到期项（presence + intra-day 序）仍 L1 确定性，**不动**（档2 不取档3）。

## 档2 流水（落地形态）

```
L1 候选信号收集（确定性，读 DB）
   → 每个非到期候选算 SelectionCandidateSignal（mfiScore/diagnosticScore/θ̂_min/θ_se/b/b_source/recall_eligible/§9.2 best-effort）
L2 SelectionOrchestratorTask（AI，单 persona，mimo-v2.5）
   → 每候选 {weight, role, arrangement, reason}（主脑：选哪些+怎么排+为什么）
薄 sampler（tempered-softmax，T>0）
   → 按 LLM 权重抽样落题 + 记真 π_i（softmaxProbabilities）
L3 薄守门（确定性）
   → 4 铁律：①不写 b ②到期 presence+序 ③recall 不换题 ④容量+draft+dedup
```

**两级 fallback**：LLM 挂 → 纯统计 sampler（MFI 当权重）→ 再挂退 `composeDailyStream`（legacy）。

## Map 阶段揪出的 5 个冲突 + 解法（已锁）

1. **纯度墙**：`composeDailyStream`（stream-composer.ts）sync/pure + 7 单测。L2 异步编排放 **shell（stream-store.ts）**新 async 路径；`composeDailyStream` 原样留作 legacy/fallback，7 单测保持绿。
2. **模型路由**：L2 结构化输出 task 跑 mimo-v2.5（runtime）；**实现/测试不得用 sonnet/GLM**（StructuredOutput 不兼容，见 memory）。
3. **测试保全**：softmax 路径是**独立新代码路径**（非改 composeDailyStream），默认 'legacy' 保旧测绿，新增 softmax 路径不变量测试。
4. **两个新 L3 落点**（现码没有）：到期 presence 显式断言 + recall 源头切断（不喂 MFI/sampler）。
5. **无 policy/flag 基建**：新建 `SelectionPolicyConfig`（默认 'legacy'）+ `selection-constants.ts`，typed config 线程进 shell（参 `capacity?` 既有传法）。

## Sub-step 分解（顺序，同分支链式 commit）

- **Step A — 候选信号收集（Task 7）**〔本步起〕：`src/capabilities/practice/server/candidate-signals.ts`（server 侧 collector，复用 core `selection-signals.ts` 数学）。读 mastery_state(θ̂/precision via getMasteryState)、item_calibration.b(track=hard)、difficulty 弱锚兜底、多 KC θ̂_min、`rotationClassForKind` recall-eligible。§9.2 三信号：有 cheap 数据源就填，否则留 `undefined`（不 zero-fill）。**零行为变更、纯数据、可全测**。
- **Step B — L2 SelectionOrchestratorTask（Task 8 L2）**：`src/core/schema/selection-orchestrator.ts`（Zod：`{candidates:[{refId,weight≥0,role,arrangement,reason}]}`）+ registry TaskDef（needsToolCall:false, maxIterations:1）+ task-prompt + `src/server/ai/selection-orchestrator.ts` parse barrier（brace-slice+Zod，参 item-prior）。走 `runTask` 拿 evidence-first 日志免费。mock LLM 测。
- **Step C — sampler + policy + 接线 + L3 + fallback（Task 8 余 + 行为变更）**：`SelectionPolicyConfig` + `selection-constants.ts`；sampler（softmaxProbabilities 出 π_i）；shell 新 async 路径（getStream/recomposeStream behind policy）；L3 守门（presence/recall-cut/容量/dedup）；两级 fallback；`recordSelectionObservation` 记 π_i（streamItemId=物化 id）。**默认 policy 见下「待 owner 决策」**。
- **Step D — 测试 + gate + PR**：softmax 路径不变量测试（到期序不变 / π 和为 1 / π_i 持久化 / recall 无 MFI 分 / LLM 挂走 fallback）+ 旧 7 测保绿；full gate；PR → main（不 merge，等 owner）。

## 待 owner 决策（不阻塞 Step A/B；Step C 接线前需定）

**rollout 默认**：Phase 3 落地后，`policy` 默认 'legacy'（owner 手动 flip 才改变每日流）还是直接默认 'softmax_mfi'（落地即生效）？
- 默认 'legacy'（**建议**）：安全，owner 先看 legacy-vs-softmax dry-run 对照再 flip；缺点是「行为变更」要多一步手动开。
- 默认 'softmax_mfi'：Phase 3 落地即改变每日流；n=1 个人工具盲翻有风险。

§9.2 三信号 Phase 3 范围（小决策，默认静默）：MFI-core 先打通，§9.2 best-effort（cheap 数据源就填、否则 undefined），不为这三个新信号自建子系统阻塞 Phase 3。

## 不变量回归锚点（L3 必须保全，Map 已定位）

到期序 `due-list.ts:316-322` · recall 路由 `variant-rotation.ts:53-55,231-287` · draft 排除 `due-list.ts:232,293` · dedup `schema.ts:968`+`stream-store.ts:175-178,200` · 容量 `stream-composer.ts:125-134` · b 只读 `state.ts:187-199`。
