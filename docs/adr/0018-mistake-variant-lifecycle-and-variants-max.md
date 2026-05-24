# ADR-0018 — Mistake Variant Lifecycle + variants_max=3 Cap

**状态**：accepted
**日期**：2026-05-24
**前置**：ADR-0006 v2（event-driven core）、ADR-0014（capability registry, profile-driven cause）、YUK-44（variant_question proposal inbox）
**关联**：YUK-17（Product Track 1 — variant double-pass）

---

## 决策

围绕「错题变式」的三个互相耦合的设计点一起定：

1. **lifecycle 载体（Schema A）** — 新建独立 `mistake_variant` 表持有 variant 在「draft / active / broken / dismissed」轴上的状态；不复用 `question` 表已有的 `draft_status` 字段做单一来源。
2. **variants_max 语义（2b）** — 每个原题最多 3 个 in-flight variant；in-flight 同时包含 **pending `variant_question` proposal**（尚未被人接受）和 **active mistake_variant 行**（已接受、还未被验证打回）。
3. **draft → active 触发点（3a）** — `variant_question` proposal accept 即把 `mistake_variant.status` 设为 `'active'`；`'broken'` 只能由 `VariantVerifyTask` 第二遍校验 verdict='fail' 写入；用户主动 dismiss / retract 走 `'dismissed'`。

---

## 背景

YUK-44 把 `variant_gen` 从「跑完即往 question 表插行」改成「写 `variant_question` proposal」。后续 Phase 3 想加：

- **二次校验**：第一遍 cause-targeted 生成、第二遍重新审视「这道 variant 真的针对得住 cause 吗 / 没飘」。
- **繁殖防护升级**：MVP 的「1-per-parent」过于保守；产品上希望同一道错题最多挂 3 道变式但不止 1 道。
- **生命周期可观测**：variant 从「AI 草拟 → 用户接受 → 等待二次校验 → 二次校验通过 / 打回」这条链每一步都要 trace 得到。

如果继续把 lifecycle 信号塞进 `question.draft_status` 这种平坦字段：

- 'broken' 没地方放（draft_status 只 `'draft' | 'active'`）
- variant 还在 proposal 阶段时根本没 question row，没法 hang 状态
- 多个并发 variants 各自的状态相互之间没分隔
- counting variants_max 要 join 多张表 + 不同 source 各种枚举

`mistake_variant` 独立表是更干净的解：每条 variant 一行，pending 阶段 `variant_question_id IS NULL` + `proposal_event_id` 指向 propose event；accept 后回填 `variant_question_id`；status 列单独驱动。

---

## 决策 1：Schema A — 新建 `mistake_variant` 表

### 选项

#### A. 新 `mistake_variant` 表（**accepted**）

```ts
mistake_variant (
  id text PK,
  parent_question_id text NOT NULL,       -- 失败原题
  variant_question_id text NULL,          -- accept 后回填
  proposal_event_id text NULL,            -- pending 阶段指向 propose event
  status text NOT NULL,                   -- 'draft' | 'active' | 'broken' | 'dismissed'
  failure_reasons jsonb NOT NULL DEFAULT '[]',
  cause_category text NULL,               -- 诊断/未来 filter 用
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  INDEX (parent_question_id),
  INDEX (status)
)
```

每个 variant 都有一条 row 持续存在；状态机集中在一个字段。

**优点**：

- variants_max counting 是一个 `SELECT count(*) FROM mistake_variant WHERE parent_question_id=$1 AND status IN ('draft','active')` —— 单表 query，O(index)。
- 'broken' / 'dismissed' 状态有地方落。
- pending 阶段 (proposal 已写但 question 没物化) variant 也能被表示 —— 即「draft 是真状态而不只是 question 字段值」。
- 加 cause_category 列后未来可以「按 cause 过滤当前用户在卡的 variant」做 dashboard。
- 增删字段（aging、override flags）不污染 `question` 表。

**接受的代价**：

- 多一张 lifecycle 表 + 一条 migration。
- 实现上要保证 mistake_variant ↔ question 双写一致（proposal accept 路径一个事务里同时 INSERT question + UPDATE mistake_variant）。
- `question.draft_status` 字段从 allowlist 里释放后仍然写（'draft' / 'active'）—— 双信号但语义对齐。

#### B. 仅扩展 `question` 表（既有 draft_status + 加 broken_at / failure_reasons）

把所有状态塞回 `question` 表。

**为什么不选**：

- pending 阶段还没 question row，状态信号无处落（YUK-44 的设计本身就把 question 物化推到 accept 时）。
- draft_status 是 `'draft' | 'active'` 的平坦枚举；加 'broken' 后语义膨胀，老消费方代码全要更新。
- variants_max counting 需要既 query question.parent_variant_id 又 query proposal 表 —— 跨源 union。

#### C. 全 event-driven，不存物化状态

每次需要 mistake variant 状态 derive from event stream（propose / accept / verify_pass / verify_fail）。

**为什么不选**：

- 与 ADR-0012（mastery as derived view）思路一致但代价不对称：mastery 是高频读、低频写；variant lifecycle 是 read-after-write 高频（UI 列「这道题的 variant」即时刷新需要 100ms 内）。
- variants_max counting 要 fold 全 event 流，pg-boss 触发延迟即可让 count 变错。
- ADR-0013（review session lifecycle）的先例已经证明：单元状态有 lifecycle 字段的轻表比纯 event derive 更适合 OLTP 场景。

### 触发重新评估

- mistake_variant 表的 INSERT/UPDATE 路径变成跨 lane 的高频写竞争点 → 评估改成 fully-derived view + materialized snapshot。
- 'broken' / 'dismissed' 之外需要更多 fine-grained 状态（如 'awaiting_user_review'）→ 评估 status 列改 state-machine 表 + transitions。

---

## 决策 2：variants_max = 3，counting includes pending + active

### 选项

#### 2a. 只算已 accept 的 active 变式

count = COUNT(mistake_variant WHERE status='active')

**为什么不选**：用户不接受的 proposal 一直堆在 inbox，AI 可以无限再生（每次新 attempt 触发 variant_gen 都写一条 proposal）—— flood inbox。

#### 2b. 算 in-flight = pending proposal + active 变式（**accepted**）

count = COUNT(mistake_variant WHERE status IN ('draft','active'))

由于 variant_gen 现在会同时写 mistake_variant(status='draft') 和 variant_question proposal，draft 即对应 pending proposal，活变式即对应 accepted。

**优点**：

- 防 LLM flood：用户不动 inbox（都是 draft），AI 也不会再帮你生第 4 条。
- 用户接受 / dismiss / 等 verify 打回都自动释放配额。
- 单表 query，O(1) 索引。

**接受的代价**：

- 用户如果不主动 dismiss 老 draft，新 attempt 触发的 variant_gen 会被 skip —— 这是设计意图（强迫用户清 inbox）。

#### 2c. 算所有 ever-generated variant（含 broken / dismissed）

count = COUNT(mistake_variant) regardless of status

**为什么不选**：永久封顶；用户清掉 inbox 也无法 unlock 第 4 道；与「错题反复练」的产品意图冲突。

### 触发重新评估

- 用户报告「我接受了 3 道，做完 1 道就想再要新的，但只能 dismiss 才行」→ 评估改成「active 计算时减去 mastered」。
- 单题 attempt 高频触发 variant_gen 把 draft 堆 inbox（即使没真生成）→ 评估在 variant_gen 入口先 count 再决定要不要调 LLM。

---

## 决策 3：proposal accept = active；broken 只由 VariantVerifyTask 设置

### 选项

#### 3a. accept → 'active'，broken 由 verify task 单独设置（**accepted**）

用户 accept proposal 后 mistake_variant.status='active'（question 同时物化）。Verify 是异步 second-pass，verdict='fail' 才把 status 改成 'broken'。

**优点**：

- 用户体验：accept 即刻生效，可以做题；verify 在后台跑（典型 30-60s），不阻塞 UI。
- 故障隔离：verify task 挂掉（LLM 调用失败）不会把 variant 卡在 limbo —— variant 仍然 'active'，用户能用；下次 verify 重新跑。
- 简化原子性：accept 路径不需要等 verify 结果；只需要 INSERT question + UPDATE mistake_variant + ENQUEUE verify job 在一个事务里。

#### 3b. accept → 'pending_verify'，verify pass 才升 'active'

用户 accept 后变式不立即可用，要等 second-pass 通过。

**为什么不选**：

- 阻塞 UX：用户接受了但「为什么我做不到这道题」—— 需要解释「等 AI 二次校验」，加学习成本。
- verify task 挂 → variant 永远 stuck。
- 与 note_verify 设计不对称（note_verify 是 needs_review proposal，不阻塞 note 本身）。

#### 3c. accept 即 'active' 且 verify 不存在（无 second pass）

放弃 second pass。

**为什么不选**：YUK-17 本质就是加 second pass。决策 3 是「second pass 怎么 fit lifecycle」，不是「要不要 second pass」。

### 触发重新评估

- AI 生成质量足够稳定，verify pass 历史 99%+ 通过 → 评估抽走 verify task 节省 LLM 成本。
- 用户反馈「broken 的 variant 还出现在做题列表里因为 status 改成 broken 之前他们已经做过了」→ 评估 active 阶段加 quarantine 期。

---

## CC invariants 怎么兼容

- **CC-1 cause-policy**：VariantVerifyTask 拉「原始 attempt 的 effective cause」时 MUST 用 `effectiveCauseForFailureAttempt()`；不要绕过 user-vs-agent precedence 单独 query judge。
- **CC-3 JudgeInvoker**：不涉及 —— VariantVerifyTask 是 content-level「这条 variant 是否还针对原 cause」判定，不是 answer-grading。
- **CC-4 Proposal lifecycle**：variant_question proposal accept / dismiss / retract 必须走 `acceptAiProposal / dismissAiProposal / retractAiProposal`，写对应的 rate / correct event；不绕 owner-service 直接改 mistake_variant。

---

## 实施计划

仅 sketch，不属于 ADR 决议范围。详见 `docs/superpowers/plans/2026-05-24-yuk-17-variant-double-pass.md`。

1. 创建 `mistake_variant` 表 + migration 0013
2. 加 `VariantVerifyTask` TaskDef + prompt builder + `VariantVerificationResult` Zod schema
3. 改 `variant_gen` 同时写 mistake_variant(status='draft')；加 variants_max=3 gate
4. 创建 `variant_verify` boss handler
5. 改 `acceptAiProposal` / `dismissAiProposal` 给 variant_question 分支
6. 注册 `variant_verify` queue
7. 释放 `question.draft_status` 的 audit-schema allowlist 条目
