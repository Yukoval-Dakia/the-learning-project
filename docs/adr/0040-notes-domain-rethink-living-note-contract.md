# ADR-0040 — 笔记域 re-think：Living Note 出手契约 + check 段 + 挂载 + 进度可见性 + 信号治理

**Status**: Accepted (2026-06-15)
**Part of**: YUK-203 ·「整个产品重新想」笔记域 re-think（主 rethink 跳过最狠的核心域，owner 单拎重想；114-agent 审计 notes-artifact 镜头报 9 缺口）。
**Decision source**: notes-domain understand 现状地图（`docs/design/2026-06-15-notes-domain-current-map.md`，workflow `notes-domain-current-map` 7-agent grounded，含 file:line 核验）+ owner 2026-06-15 逐项拍板（9 决策，3 批）。
**Related**: ADR-0020（note artifact / 五段 / knowledge_ids label）· **ADR-0039（A/B/C 出手强度表——本 ADR amends note_update 档位）** · ADR-0036（双层异构图 misconception 节点 H7）· ADR-0038（统一 verify 契约——本 ADR amends note_verify 第四套并入边界）· ADR-0035（B1 mastery_state）· D6（删内嵌自测）。

---

## 决定

### 1. AI 改笔记出手契约 = 按可逆性 + user_verified 拆 A/B + 统一撤销（amends ADR-0039 note_update=B）

- **小改**（现 gate `ops≤3 且 new_blocks≤2`，**且不触 user_verified 块**）→ **A 档**自动应用 + 撤销窗口，补齐 ADR-0039 A 档配套（单位时间**熔断** + **统一 revert UI**）。
- **大改 或触 user_verified 块** → **B 档** propose 人审。
- **user_verified = refine 硬边界**：`apply-note-patch` 对 `user_verified` 块拒绝 mutator 直改，强制走 propose——**修最严重故障缺口**（现 apply 路径对 user_verified/source_tier grep 零命中，AI 静默覆写用户已验证内容，破 propose-only 红线）。
- **撤销链统一**：mutator 与 propose-accept 都走一个 ai-changes undo；给 `retractAiProposal` 补 note_update body_blocks 回退分支（复用已存但无调用方的 `reverse_patch`）。
- 这把 ADR-0039 A/B/C 表的 note_update=B **精化**为「note_update 按可逆性/user_verified 拆 A/B」——符合 ADR-0039「拿不准/不可逆归 B」判据；A 档配套（熔断 + revert UI + user_verified 硬边界）满足后，小可逆改才安全下放 A。

### 2. mastery_change 触发器 → 读 mastery_state 真实 p(L) delta（gated B1）

重命名诚实化；触发条件从 `outcome==='success'`（纯成败代理，现从不读任何 mastery 数值）改为「p(L) 跨阈变化」。**gated 在 B1 `mastery_state` 落地**；跨阈阈值是 n=1 magic number，**先埋点 N 周再定**（撞 phase2 §6.4 高危组）。B1 基础设计须补 living note 链的 mastery_state 读接口（现 B1 doc 对 living note 零提及）。

### 3. check 段 → 自我解释提示（不判分）+ 真删 embedded_check 孤儿链

check 段的「判分自测」用途已被 **D6（删内嵌自测）+ B1（开放题自测无法机判）双杀**。降级为 **self-explanation 反思提示**（不判分 / 不喂 mastery / 不 enroll）——**落地 GPT `self_explained` pedagogy**（Chi 自我解释，主 rethink + GPT 对账 deferred 到此）。verify 五段软门保留（atomic 缺段 needs_review）。

**同时真删 embedded_check 假删链**：现状只删了 error_rate 一条 refine 信号，但 `embedded_check_generate` boss.send / `embedded_check_status` 列（4 态）/ embedded-check·attempt 路由（199 行 judge 逻辑）全活着是孤儿（SPA 端零 UI 消费）。本决定真清孤儿端点 / 列 / boss.send / judge 逻辑（须先确认 SPA 零消费后安全删）。

### 4. 笔记挂载保持扁平 label 不动 + deferred hook

守 ADR-0020 **三约定**（atomic=1 / 不进 mastery / cross_link 与 knowledge_edge 分层）。「note 进图喂 mastery」与 ADR-0020（mastery 只从 question events 派生）+ B1 `mastery_state` 单写路径**直接冲突——不做**。纠错笔记挂 misconception 节点 / 沿 typed-edge 聚合 = **deferred hook**：misconception 节点（ADR-0036 H7 观测期自由文本 + pgvector 聚类）落地后再看纠错笔记挂载。hub_auto_sync 的 relation-chip infra 可复用。（收敛非重建：不破坏 working 的刻意设计无具体需求。）

### 5. 笔记进度可见性 = 接 generation status + 统一改动时间线 + 沉淀量进步信号

- 接 wire 上已有的 `generation_status` 到 reader（**生成中骨架** + 失败重试入口，修「生成中笔记 reader 看不出正在生成、直接渲空块/半截」）。
- **统一改动时间线**：reader timeline 显示 AI refine（修 history 双轨分裂——人工编辑写 `artifact.history` jsonb / AI refine 走 event 表，reader timeline 现只见前者）。
- **沉淀量作进步信号**（笔记覆盖 / 演化深度 / 反链密度作「整理过 / 理解了多少」的可见信号）→ 进**成效层**（YUK-354 成效面），gated 在成效层语义先定。

### 6. 下线 dwell 触发，保留 editing_presence defer

删 `editing-heartbeat`→refine 触发（最弱信号「纯编辑驻留」、最频繁、kill switch 实际无效、跨进程 debounce 失效、⚖️ 从 M3 拖到现在）。其余三信号（mark_wrong / review_success / dreaming）是真学习信号。**保留 `editing_presence` 的「编辑时 defer AI 改动」并发仲裁**（决定 1 的 A 档自动应用仍需要它，不一起砍）。连带：dwell 下线后评估 editing_presence defer 可否简化 + 修 dwell 下线遗留（跨进程 debounce 一致性债随之消失）。了结拖三个里程碑的 ⚖️ 争议。

### 7. note_verify → advisory + 可选触发 refine（修死提议 bug，amends ADR-0038 第四套并入边界）

note_verify **不再产 patch-less note_update proposal**（死提议根源——唯一 accept applier 硬要求 `NotePatch.safeParse(change.patch)`，对 undefined 必抛 400，proposal 进收件箱却只能 dismiss，零测试覆盖）。verify 发现的 issues 落 **advisory**（artifact 已有 `verification_summary` 字段承载）+ 可选触发 note_refine 产真正可应用的 fix patch 走决定 1 的 mutator/propose 路。**verify（诊断）与 refine（修）职责分清**。

---

## 后果

**正面**
- propose-only 红线在笔记面补全（user_verified 硬边界）；撤销链统一；死提议 bug 消除；verify/refine 职责分清；embedded_check 假删债真清；dwell ⚖️ 争议了结；生成态可见 + history 双轨合一；GPT `self_explained` pedagogy 落地。
- 笔记域从「整个 rethink 跳过最狠的核心域」收口为 9 条 grounded 决策。

**代价 / 风险**
- mastery_change 真 delta **gated B1** + 阈值埋点（n=1 magic number，可能长期停先验）；沉淀量进步信号 **gated 成效层**语义。
- A 档配套（熔断 + 统一 revert UI）是新工；user_verified 硬边界需 `apply-note-patch` guard + **回归测试**（现零「不破坏 user_verified」断言）。
- embedded_check 真删须先确认 SPA 零消费（孤儿端点/路由）后安全删，避免误删活路径。
- 整域对 D14 对话面仍零可达（无 copilotTools 贡献）——本 ADR 不解决，留作 copilot 工具面缺口（审计 copilot-conversation 镜头）。

## 备选（已否决）
- **note_update 全 B 档（砍 mutator）**——否决：小可逆改自动应用对日用价值高，A 档配套 + user_verified 硬边界后安全。
- **note 进知识图谱喂 mastery**——否决：破 ADR-0020「mastery 只从 question events」+ B1 单写路径。
- **check 段保留判分自测**——否决：D6 + B1 双杀，判分自测对开放题无效。
- **dwell 保留**——否决：最弱信号、kill switch 失效、AI 因驻留就改打扰。
- **note_verify 产可应用 patch**——否决：verify-兼-修 模糊职责分离；advisory + 触发 refine 更清。
