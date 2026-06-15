# Copilot 真正全能 · per-utterance checkpoint（PR 模型）

**Date**: 2026-06-15（rev 2 — owner 修正：参考 git PR + 「用户一句话=一个 checkpoint」，砍掉 v1 的 LIVE/PREVIEW 隔离 overlay）
**Status**: **Design-in-progress**（模型已收敛；级联 revert 机制 + diff/PR 面 + cherry-pick 依赖序 待续）
**Part of**: AI pipeline re-think · D14 编排轴 · copilot 真正全能（write-safety 这一腿；另两腿=reach「够得着全部 task」+ endurance「异步长程」另议）
**Decision source**: owner 2026-06-15「成本无所谓，copilot 真正全能（像我用 Claude Code）」→「propose 阻塞多步，先落库但保留 revert」→「**参考 git PR，但参照 Claude Code 是『用户一句话=一个 checkpoint』**」。
**Grounded on**: AI-pipeline understand map + 撤销基建核验（CorrectionKind / caused_by_event_id / archived_at / draft_status / answer 表 / user_ask 事件 / 乐观版本锁）。
**Related**: ADR-0039（A/B/C——本设计是 A 档「自动+撤销」推到 turn 级）· ADR-0040（笔记 mutator apply+undo = per-event 版同款）· ADR-0006（event=SoT，派生可重放=地基）· ADR-0025 ND-5（propose-only——本设计把闸从 per-change 搬到 per-utterance）。

---

## 0. 问题

owner 要 copilot 真正全能（成本不计），像 Claude Code 那样长程多步自主。`propose→inbox→人审` 是个**逐改动的同步人类闸**，从根上掐死多步——提条边，下一步想用它，没 accept 就不是 live，链条走不通。本文给写侧/安全侧的解：**per-utterance checkpoint（PR 模型）**。（reach + endurance 两腿另议。）

## 1. 核心 reframe：审批闸从「逐改动」搬到「逐句话」

```
propose-inbox:  改①→审→改②→审→改③→审        每步等你，多步走不通
per-utterance:  你说一句 → copilot 多步[改①改②…改⑳] → 一个 PR：净 diff + 一句话总结 → keep/revert/cherry-pick
                下一句 → 建在已 live 的基础上（线性 timeline，像一串 git commit）
```

闸还在，但**一句话一个、而非一改动一个**——一次 review 顶整轮全部改动。这正是 Claude Code 的体感：我一轮干一堆，你看 diff 整轮 keep/revert。**这是 propose-only 的进化（闸搬到 turn 边界），不是抛弃。**

## 2. 模型：live + per-utterance PR + 级联 revert（= git/Claude Code）

**改动直接落 live**（不隔离）。copilot 读 live → 看得见自己上一步刚改的 → 接着建（多步链条通）。**v1 的 LIVE/PREVIEW 隔离 overlay 不需要了**——「它看得见自己草稿」被「直接落库」自动满足，可见性 filter 是为隔离造的，而我们选的是「落库 + 事后撤」。**少一大块工程。**

**一句话 = 一个 checkpoint = 一个 PR**：
- **锚**：copilot 每请求已写一条 `user_ask` 事件 → 它就是 PR 锚（`checkpoint_id = user_ask event id`），一句话一个，不用新发明。
- **PR 的 commit 图**：turn 内所有写 `caused_by` 链回 user_ask → 既是「这个 PR 含哪些改动」，也是 revert 的依赖序来源。
- **PR 三件套**：① 净 diff（跨实体聚合：N 节点/M 边/K 题…）② 一句话总结（copilot 自述「我干了啥/为啥」=PR description）③ keep（默认/继续对话即接受）/ revert 整 PR / cherry-pick 单条。

**revert = event-sourcing 红利**：撤一个 PR = 对它那组事件追加补偿事件（`CorrectionKind=retract/supersede/restore`），派生态重算——**非破坏性删**。撤早期 PR 要级联（后面 `caused_by` 它的一起补），依赖序从 caused_by 链来。

## 3. 安全模型变了（要 owner 拍，已倾向接受）

per-utterance + 落库，安全模型从 **approve-before（propose 先批后改）** → **revert-after（先改后可整撤）**。这是「真正全能」的代价。判断：对 n=1 成立——你在看、窗口短、一句话一个 diff 摆面前。它**软化 propose-only**：以前「没批不动你数据」，现在「动了但每句话可整撤」。

**唯一保留 hard 的：user_verified。** 即便 live+revert，AI 自动覆写你亲手标「已验证」的内容你可能划过没注意 → user_verified 块的改动在 PR diff **强制高亮 + 默认不 included（要你主动勾）**。其余 live+revert。

## 4. 地基已就位（不是凭空建）

| 现有件 | 提供的 |
|---|---|
| `user_ask` 事件（copilot 每请求一条） | **PR 锚**（checkpoint_id），一句话一个 |
| `caused_by_event_id`（event 因果链） | PR 的 commit 图 + 级联 revert 依赖序（**但现状未在 copilot 写路径一致设置→要补**） |
| event=SoT + 派生可重放（ADR-0006） | revert=追加补偿事件、派生重算，非破坏删 |
| `CorrectionKind=[supersede,retract,mark_wrong,restore]` + `archived_at` | 补偿原语（每种写的逆操作） |
| 乐观版本锁（note/artifact version，409） | live 时并发（你同时编辑）冲突检查 |
| `draft_status` / `answer` 表 | 「不可见草稿 / 可变工作区 commit 成事件」先例（如某些写仍想要 turn 内不 live，可选用） |

blast radius：补全 caused_by 链 + 一个 per-PR diff/revert 面 + 级联 revert 器。**比 v1 的全产品可见性 filter 小得多。**

## 5. 硬的部分（诚实标，待续）

1. **级联 revert 机制**（核心待挖）：撤 PR-N → 补偿其事件 + 所有 `caused_by` 链到它的下游事件，按反依赖序。要先**补全 copilot 写路径的 caused_by 设置**（现状不一致）。
2. **不可逆下游**：跨 turn 撤旧 PR 时，若其改动已触发副作用（题进 frontier→你已练→真 attempt 事件），revert 撤不掉已练。per-utterance 窗口内罕见（你还没练就 review 了），但「能干净撤多久前的 PR」有边界。
3. **commit 冲突**：PR live 后你又手动编辑同实体 → 复用乐观版本锁，冲突走 409 同款。
4. **cherry-pick 依赖序**（v2）：撤 PR 里一条但留其余，要按 caused_by DAG（撤节点必先撤引用它的边/题）。v1 先整 PR keep/discard。
5. **GC**：废弃/超时未处理的 PR 标记回收（复用 note refine stale-drop）。

## 6. 与 ADR 的关系
- ADR-0039 A 档（单改动 自动+撤销）→ 本设计 = **A 档推到 turn 级**（一句话内自动多步 + turn 级整撤）。
- ADR-0040 笔记 mutator（apply+reverse_patch+undo）= **per-event 版同款机制**，本设计是 turn 级泛化。
- propose-only（ADR-0025）：闸从 per-change 搬到 per-utterance；user_verified 硬边界（ADR-0040）保留（PR diff 强制高亮）。

## 7. 状态 / 待续
模型收敛（live + per-utterance PR + 级联 revert）。未 ADR 化，待级联 revert 机制 + diff/PR 面 + cherry-pick 依赖序 讨论收敛。copilot 全能另两腿（reach「够得着全部 task」+ endurance「异步长程不被 6 轮掐」）另议——见 AI-pipeline map decision_inputs #5。
