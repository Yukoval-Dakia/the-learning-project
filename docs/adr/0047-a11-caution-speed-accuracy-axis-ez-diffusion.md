# ADR-0047 — A11 谨慎 / 速度-精度轴（EZ-diffusion 描述符）

**Status**: Proposed (2026-06-27) — 草案，待 owner ratify，勿自行改 Accepted。
**Part of**: YUK-445 · 学习者全面档案 — n=1 firm-up · P5 效率/描述符 · Wave2 axis2。
**Decision source**: YUK-445 body + 「🛠 实施讨论 · grounded 2026-06-27」comment（对照 main 代码核对）。审计修正：A10（YUK-444 confidence 轴）已 HOLD，本 ADR 只覆盖 A11。
**Related**: ADR-0035（mastery_state 三维 + 四引擎——θ̂/p(L)/difficulty 三正交轴；A11 是与 θ̂ **正交**的第四类描述符，非第三轴的替代）· `docs/design/2026-06-19-comprehensive-learner-profile.md` §1（`learner_axis_state` 表形状）/§7（P5 路线）/§8（诚实天花板）· `docs/superpowers/research/2026-06-20-axis2-calibration-math-dossier.md`（A11 在 Tier-3 preprint/by-analogy）。

---

## 背景

θ̂（能力）无法区分两种「慢」：题目对该学习者更难（证据积累速度 `v` 低）vs 学习者本身更谨慎（决策边界 `a` 更宽）。Wagenmakers / van der Maas / Grasman (2007, PB&R, ≈2000+ citations) 的 EZ-diffusion 有**闭式解**，用 mean correct RT + correct-RT 方差 + 正确率反推 `v`/`a`/`Ter`，且摘要明确点名适合 **data-sparse 单被试**——是少数专门照顾 n=1 的方法之一。RT 数据已 durable：solo PfSolo 的 `submit.ts` 把 UI 的 `latency_ms` 落进 `action='review'` event payload 的 `duration_ms`（submit.ts:564），卷面 `paper-submit.ts` 走 `action='attempt'`；writer 两者皆收（`inArray(action, ['attempt','review'])`）。单用户工具下 solo 复习（review）是主 RT 源。无需新增采集接线。

## 决定

### 1. A11 = 纯慢变描述符，零引擎触碰（不需 flag）

`(drift_v, boundary_a, ter)` 写进新表 `learner_axis_state`（per-KC 慢变覆写），**绝不**喂 θ̂ / p(L) / 选题调度。读出只走 `placement-profile`（显示用）。因此 A11 本体**不触任何 LIVE 估计引擎**，按「数据门只 gate 翻转不 gate build」之外的另一类——它压根不接引擎——故**不需 dark-ship flag、不需 byte-identical 锚**。这条红线由 axis2 数学档案的 Tier-3 裁决强制（preprint/by-analogy，就绪度最低）：保持描述符身份 = A11 安全。

### 2. drift_v 的 provenance 硬边界（A11 的核心张力）

自适应主流程里选题策略（A3 MFI/KL，`target-discovery.ts`）把 Pc 压在目标带 → `v` 的「难度」解释被混淆（v 吸收了选题策略，非纯学习者）。故：

- **`drift_v` 只在非自适应 probe-set（`provenance='probe'`）上持久化**；
- 自适应主流程（`provenance='adaptive'`，当前唯一 live 源）写 `boundary_a` + `ter`，`drift_v` 留 NULL。

当前**无非自适应定差 probe-set 题源**（仅有 fixed-anchor 校准锚 / A13 误解 probe，都非定差 probe-set）。故本 ADR 落地时 `drift_v` 列 + writer + provenance gate **全部接线就位**，唯一 defer 的是 probe-set 数据源——符合「defer flip not build」：collect/compute/gate 全通电，只等 probe 源到位翻最后一档。

### 3. usage-gated（数据不足返空，非 flag）

per-KC 累计 ≥ `AXIS_MIN_OBS`(=30) 计分 RT 作答才算一组 EZ；不足 → 不写行（描述符缺席，非伪造）。EZ 退化（chance Pc / <2 correct RT）→ 闭式返 null + 带 reason，writer 写 n_obs 但 a/Ter 留 NULL，**绝不伪造中性值**（同 `forwardAuc` 单类返 null 的纪律）。

### 4. n=1 admissibility（litmus 守门）

`(v, a, Ter)` 由**单学习者自身充分统计量**（Pc、correct-RT 均值/方差）闭式反推 → 描述符 admissible。**关键红线**：此处 `boundary_a` = 该学习者**自身决策边界（谨慎度）**，**绝不是** 2PL 的 item discrimination（后者要跨被试方差，是 litmus 禁的 a/slip/guess/φ 族）。代码 + schema 注释显式区分，防审计误判为禁项参数。`s`(=0.1) 是 owner 固定标度常数（领域标准约定），非估计量。

## 形态

- **纯闭式模块** `src/server/calibration/ez-diffusion.ts`（与 auc/ece/replay 同目录，PURE + unit-test，含 Wagenmakers App 的 Pc∈{0,1} edge-correction + 退化裁决）。
- **新表 `learner_axis_state`**（5 处登记面：schema.ts / migration 0053 / audit:schema write-path / export FK_ORDER + SCHEMA_VERSION 4.10→4.11 / tests ALL_TABLES）：`(drift_v, boundary_a, ter, n_obs, provenance)` + (subject_kind, subject_id) 唯一。A10（HOLD）未来加 `calibration_curve_json` 列（additive 列，不 bump）= 本表第二 writer。
- **batch writer** `src/server/calibration/axis-writer.ts`（advisory-lock 独立 namespace `axis_state:`）+ nightly job `axis_state_nightly`（practice manifest，cron 05:40 Asia/Shanghai）= 唯一 live writer。
- **读出面**：`placement-profile` 每 KC 投影附 `axis` 字段（profile 投影，非新路由）。

## 后果

- ✅ θ̂ 之外多一个正交着力点（教研团可说「过度求稳」而非只「不会」）。
- ✅ 端到端非死代码：writer（nightly job）+ reader（placement-profile）都 live。
- ⚠️ `drift_v` 在 probe-set 源到位前恒 NULL（已知 defer，非缺陷）。
- ⚠️ **`boundary_a`/`ter` 在自适应流里也吃 Pc-pinning**：EZ 闭式 `a = s²·logit(Pc)/v` 是 Pc 的直接函数，自适应选题把 Pc 钉在目标带 → estimator 层面 `a` 的数值同样带选题偏差，并非只有 `drift_v` 被混淆。latent-trait 层面「谨慎度是 response-style，跨难度更稳」可辩（故仍作描述符保留），但 estimator 层面不免疫——见决策点 5。因 A11 不喂任何 LIVE 引擎，此偏差不构成正确性 blocker（描述符身份兜底）。
- ⚠️ Tier-3 就绪度：A11 输出不可进算法；任何「让 a/Ter 修正 A1 的 d」是**独立 flagged follow-up**（YUK-449 territory），不在本 ADR scope——触 LIVE SRT 引擎，需 dark flag + V-A1-fwd byte-identical 锚。

## 待 owner 决策点

1. usage-gate N（30 vs 50/KC）与标度常数 `s`（0.1 约定）取值。
2. `Ter` 基线 KC 粒度（现实现 per-KC）vs 全局粒度（body「运动/阅读基线」偏全局）。
3. 建表归属确认（本 ADR 由 A11 落表，A10 解除 HOLD 后加列）。
4. 是否升 `axis_state_nightly` 为 CI/可观测 gate（当前纯 job，无 alarm）。
5. **显式 ratify「自适应流 EZ-`a`/`ter` 估计带 Pc-pinning 偏差但仍作描述符保留」**：决策 2 只把 `drift_v` 呈现为被混淆项，但 `boundary_a`/`ter` 在 estimator 层面也吃选题策略（后果 §⚠️4）。owner 应确认这是 acceptable（描述符身份兜底，不喂引擎），别让「只有 drift_v 被混淆」的叙述误导。
6. **attempt（卷面首答）+ review（solo 间隔复习）的 RT 汇入同一 per-KC EZ 池**（`foldResponsesByKc` 不分 action）：两者是不同认知过程、RT 分布迥异，而 EZ 假设单一二择决策过程。作为描述符可辩，但 owner 应确认是否接受混池，或未来按 action 拆双描述符。
