# Copilot 真正全能 · checkpoint 草稿层设计

**Date**: 2026-06-15
**Status**: **Design-in-progress**（owner 与 Claude 对话推演中；conflict/merge 语义 + diff/review 面 + 与 per-event undo 共存 尚在讨论）
**Part of**: AI pipeline re-think · D14 编排轴（主 rethink 跳过的「AI 调用编排机器」一轴）
**Decision source**: owner 2026-06-15「成本无所谓，我希望 copilot 真正全能（像我现在用 Claude Code 一样）」+ 逐层对话推演（propose 阻塞多步 → apply+revert → checkpoint 草稿层）。
**Grounded on**: AI-pipeline understand map（workflow `ai-pipeline-current-map`）+ 撤销基建代码核验（retractAiProposal / CorrectionKind / caused_by_event_id / archived_at / draft_status / answer 表）。
**Related**: ADR-0039（A/B/C 出手强度——本设计是 A 档「自动+撤销」推到任务级）· ADR-0040（笔记 mutator apply+undo 先例）· ADR-0029（answer 表复活为草稿工作层先例）· ADR-0006（event 是 SoT，派生可重放——本设计的地基）· ADR-0025 ND-5（propose-only 正主——本设计是其进化非抛弃）。

---

## 0. 问题

owner 要 copilot **真正全能**（成本不计），像 Claude Code 那样长程多步自主。现状机器层挡在三处（understand map）：① 够得着的只有 26 个被包成 copilotTool 的（27+ task 大半碰不到）② 内联同步跑子 task，吃 6 轮父预算 + 阻塞 ③ **propose→inbox→人审是同步人类闸，从根上掐死多步**——copilot 提条边，下一步想用它，没 accept 就不是 live，链条走不通。

本文专攻 ③ 的解法，并给出比「直接落库+revert」更干净的形态：**checkpoint 草稿层**。

## 1. 核心 reframe：审批闸从「逐改动」搬到「逐任务」

propose-only 现在把闸放在**每个改动**上（提一条审一条）→ 多步走不通。checkpoint **不取消闸，是搬闸**到任务边界：

```
propose-inbox:  改①→审→改②→审→改③→审       （每步等你，多步走不通）
checkpoint:     [改①→改②→…→改⑳] → 看净 diff → 整组 commit / discard
                 └ copilot 在隔离层自由多步、建在自己的草稿上 ┘
```

闸还在——**你的真实学习态没经你批不会变**——但 copilot 在 checkpoint 内放开手脚，你审的是**这次任务的净效果**。**这是 propose-only 的进化，不是抛弃。**

## 2. 设计：在 event-sourced 架构里的形态

**数据层**：一次 copilot 多步任务 = 一个 `checkpoint`（envelope）。任务内所有写**照常 append 事件，打 `checkpoint_id` + `status=draft`**。

**可见性 scope（核心机关）**：派生读分两态——
- **LIVE**（产品默认 + 你的真实学习态：FSRS/mastery/frontier/today 流 全看这个）：只认 committed 事件。
- **PREVIEW(checkpoint)**：committed + 该 checkpoint 的 draft 事件叠加。
- **copilot 任务内的读写走 PREVIEW(自己的 checkpoint)** → 它看得见、用得上上一步的草稿（多步链条通）；产品和你的真实态走 LIVE → **纹丝不动直到 commit**。

**commit** = checkpoint draft→committed，事件并入 LIVE，派生态重算（带乐观版本冲突检查）。
**discard** = checkpoint→abandoned，draft 事件**永不进 LIVE**——本来就没进过，discard 干净到连补偿都不用追（event-sourcing 红利）。

与 Claude Code 同构：checkpoint = copilot 的 working tree（它自己看得见、接着干），你 review 净 diff，commit=push / discard=丢分支。

## 3. 地基已有先例（不是凭空建）

| 现有件 | 提供的半边 |
|---|---|
| `draft_status='draft'`（question，Option B invisible to pool/review/FSRS，promote 才 live） | **「不可见直到提交」**——checkpoint 把它从单题推广到全部结构改 |
| `answer` 表（ADR-0029 复活为答题卡草稿层，可变工作态，submit 冻结 + event 引用） | **「草稿工作区 commit 成事件」** |
| event 是 SoT + 派生可重放（ADR-0006） | revert=追加补偿事件、派生重算，**非破坏性删** |
| `CorrectionKind=[supersede,retract,mark_wrong,restore]` + `archived_at` 软归档 + `caused_by_event_id` | 补偿原语 + 因果链（会话关联/级联序的底座） |
| 工具 `ctx` 已 thread `db`/`subjectProfile` | **加一个 `checkpoint_id` 进 ctx** → 26 个工具读写即 checkpoint-aware |
| 乐观版本锁（note/artifact version，409） | commit 冲突检查可复用 |

**blast radius 只在 ~15 个 copilot 读工具 + 写工具 + 一个 review 面，不是全产品**——这是它可行的关键。

## 4. 为什么对 n=1 这是「对的」而非过度工程

直觉会说：单用户没别的用户要隔离，直接落 live + 事后撤不就行？——**不行，正因为是学习数据**。copilot 多步探索里建的半成品节点/题，**落 live 就立刻进 frontier→排进练习→污染 mastery/FSRS**，你还没批。checkpoint 的隔离 = 「**copilot 的探索过程不碰你的真实学习态，直到你认可净结果**」——这恰是 propose-only 红线的本意。

**checkpoint 是唯一同时给到「多步自主 + 不污染真实态」的模型。** 直接落 live+事后撤做不到（撤之前已污染）。

## 5. 硬的部分（诚实标）

1. **可见性 filter 铺面**：理论上每个派生读要接受 scope。**收敛**：只让 copilot 的 ~15 读工具 + review 面 checkpoint-aware，产品其余读死守 LIVE，不全产品改。
2. **commit 冲突**：checkpoint 开着时 LIVE 可能变（你自己编辑/别的事件）→ commit 像 git merge；复用乐观版本锁，冲突走 409 同款。**（待深挖：merge 语义。）**
3. **commit 粒度**：v1 整组 commit/discard（原子，绕开级联）；cherry-pick（只留部分）要按 `caused_by` 依赖序——留 v2。
4. **GC**：未 commit 的 checkpoint 要 TTL 回收（复用 note refine stale-drop 思路）。
5. **per-event undo 与 checkpoint 共存**：小零散改仍可走 A 档 per-event undo（ADR-0040 笔记 mutator）；checkpoint 是「多步任务」的范式。两者边界待定。

## 6. 与 ADR-0039/0040 的关系

- ADR-0039 A 档 = 单改动「自动+撤销窗口」。checkpoint = **把 A 档推到任务级**（任务自动多步 + 任务级撤销）。
- ADR-0040 笔记 mutator（apply + reverse_patch + undo）= **per-event 版本的同款机制**，checkpoint 是其任务级泛化。
- propose-only 红线（ADR-0025 ND-5）：**保留**，闸移到任务边界（commit/discard）。user_verified 硬边界（ADR-0040）：**保留**，draft 也不许碰 user_verified 块（或碰了必须在 diff 里高亮待你确认）。

## 7. 开放子问题（继续讨论）

- **commit/merge 冲突语义**：copilot 草稿 vs 你同时的编辑，怎么合/怎么报。
- **diff/review 面长什么样**：一次任务的净效果怎么呈现给你审（N 节点/M 边/K 题 + 下钻 + commit/discard/cherry-pick）。
- **checkpoint 边界谁开**：copilot 自己判「这是多步任务开 checkpoint」还是所有 copilot 写默认进当前 checkpoint。
- **够得着全部 task + 异步长程**（understand map 另两条）：checkpoint 解决「写隔离」，但「copilot 能调全部 27+ task」「长程不被 6 轮掐」是并行的两条 D14 决策。

## 8. 状态

设计推演中，未 ADR 化。这是**架构级**改动（新 checkpoint envelope + 可见性 scope + commit/discard + diff 面），比「propose 改 mutator」大一圈，但是「真正全能 + 守住红线」的唯一干净解。落 ADR + Linear 待 §7 子问题讨论收敛后。
