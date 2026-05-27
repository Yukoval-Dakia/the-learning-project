# Wave 1 Ready-to-Launch Artifact List — 2026-05-27

> Master roadmap scenario A, Wave 1 之前的所有准备工作 checklist。
> 下次 session 接力时按本 doc §3 起手 ritual 启动 Wave 1。

**状态**：✅ archived 2026-05-27（Wave 1 已 ship，详见 §8 Ship outcome）
**Doc 日期**：2026-05-27
**前置**：scenario A locked（master-roadmap §5.0 Q5），grill 全 6 题拍板（commits 5c60f72 + 40a8972 + 01c27b2）
**Wave 1 范围**：T-37 brief writer + T-88 P0 spike + T-RA RatingAdvisor + T-66 ask_check
**估时**：~5 周（T-37 实际 13pt 拉长，非 master roadmap 原写 4 周）
**Worktree allocation**：A = T-37 → T-88 P0 (~15pt)；B = T-RA → T-66 (~8pt)
**实际启动**：launch doc 写完同日 (~10:00) 即起，到 2026-05-27 ~18:30 全部 ship 含 post-ship fix。实际跑通耗时大幅低于预估，因 driver doc + spike findings 把不确定性预消化。

---

## §1 已就绪 artifacts（5 commit 累积）

### §1.1 Planning / Driver docs（commit 5c60f72 + 40a8972 + 1a2a452）

```
docs/superpowers/plans/
  2026-05-26-yuk88-block-tree-rebuild-phase.md   YUK-88 phase index（含 P2 basic+polish 拆分）
  2026-05-26-yuk88-autonomous-driver.md          YUK-88 track driver (716 行)
  2026-05-26-yuk88-p0-spike.md                   YUK-88 P0 lane plan
  2026-05-27-master-roadmap.md                   Master roadmap (1031 行，含 §5.0 9 项决策 + §5.1 8 wave)
  2026-05-27-t37-brief-writer-driver.md          T-37 track driver (152 行，flags YUK-37 status 错标)
  2026-05-27-tra-rating-advisor-driver.md        T-RA track driver (122 行，YUK-98 created)
  2026-05-27-t66-teaching-ask-check-driver.md    T-66 track driver (123 行)
```

### §1.2 Audit baseline（commit 01c27b2）

```
docs/audit/
  2026-05-27-pre-yuk88-baseline-drift.md         15 findings: P1×4 / P2×5 / P3×6 / N×6
```

### §1.3 ultragoal ledger（init at 1a2a452 前）

```
.omc/ultragoal/                                  YUK-88 8 phase G001-G008 per_story mode
  brief.md         (= yuk88 phase index 副本)
  goals.json       (G001..G008)
  ledger.jsonl     (event log)
```

### §1.4 Linear issues

| Track | Linear | Status | 启动前需调整？ |
|---|---|---|---|
| T-37 | [YUK-37](https://linear.app/yukoval-studios/issue/YUK-37) | ❌ Done (错标) | **⚠️ 必须 reopen → In Progress**（commit msg 之前不能再 Closes） |
| T-88 P0 | [YUK-90](https://linear.app/yukoval-studios/issue/YUK-90) | Backlog | 启动手动 flip In Progress |
| T-RA | [YUK-98](https://linear.app/yukoval-studios/issue/YUK-98) | Backlog | 启动手动 flip In Progress（created 2026-05-27） |
| T-66 | [YUK-66](https://linear.app/yukoval-studios/issue/YUK-66) | Backlog | 启动手动 flip In Progress |

### §1.5 Git state

```
Branch: docs/yuk-88-yuk-89-note-followup
Ahead of origin by 5 commits:
  01c27b2 docs(audit): pre-YUK-88 baseline drift audit (15 findings, 4 P1)
  40a8972 docs: Wave 1 track driver docs (T-37 + T-RA + T-66 + YUK-98 created)
  5c60f72 docs: master roadmap grill conclusions (scenario A locked)
  1a2a452 docs: master roadmap + YUK-88 autonomous driver + phase plans
  c452775 docs: YUK-88 post-grill spec + ADR-0020 + supersede ADR-0019
```

**未 push**。下次 session 应决定：merge to main + push，还是先 review？建议 review。

---

## §2 Wave 1 启动前 critical preflight（启动 lane subagent 前必跑）

按顺序：

### §2.1 修正 Linear / master roadmap stale 状态

1. **Reopen YUK-37** → status flip "Done" → "In Progress"（Linear UI 手动；commit 不触发反向 flip）
2. **Update master roadmap §2.2 T-37 row** 与 §11 T-37 card：5pt → 13pt；🟡 → ⬜ pending；append "audit F-04 confirmed src/server/memory/ 目录不存在 2026-05-27" 注释
3. **Update master roadmap §0.3 当前快照** "🟡 YUK-37 brief writer Phase B：in progress" → "⬜ YUK-37 brief writer Phase B：pending 实施（audit F-04 + commit 1bca5b9 commit body 实证）"
4. **Push 5 个 commit 到 origin**（用户决定时机；建议先 review 再 push）

### §2.2 ultragoal multi-track migration（Wave 1 启动前一次性）

当前 `.omc/ultragoal/` 占用为 YUK-88 8-phase 主 ledger。Wave 1 新增 3 个独立 track ledger 需要 swap：

```bash
# 当前状态
ls .omc/ultragoal/
# brief.md  goals.json  ledger.jsonl  (YUK-88 8 phase)

# Step 1: 把现有改名为 track-88
mv .omc/ultragoal .omc/ultragoal-track-88

# Step 2: 验证（不动 symlink，先确认改名 OK）
ls .omc/ultragoal-track-88/

# Step 3: 启动新 track 时（per Wave 1 起手）
mkdir .omc/ultragoal
omc ultragoal create-goals \
  --brief-file docs/superpowers/plans/2026-05-27-t37-brief-writer-driver.md \
  --claude-goal-mode aggregate \
  --goal "T-37 brief writer impl::Mem0 spike + 6 src/server/memory/* files + tests"

# 切回 track-88 时（YUK-88 P1 启动）
mv .omc/ultragoal .omc/ultragoal-track-37  # 先保存当前 track-37 ledger
mv .omc/ultragoal-track-88 .omc/ultragoal  # restore track-88 ledger

# 或者用 symlink (per master-roadmap §6.3)：
rm -rf .omc/ultragoal
ln -s ultragoal-track-88 .omc/ultragoal
# 切 track 时改 symlink 目标即可
```

**简化方案**（Wave 1 不需要 4 个独立 ledger，所有 track 都在 Wave 1 内）：

- 暂时**只保留 YUK-88 8-phase ledger**（`.omc/ultragoal/` 当前状态）
- Wave 1 内的 T-37 / T-RA / T-66 状态用 **Linear issue + driver doc** 跟，不进 ultragoal
- 只在 T-88 phase 启动时（最早 Wave 2 P1）才动 ultragoal
- Wave 2 启动前再做 multi-track ledger 重构

**推荐路径**：简化方案。Wave 1 不动 ultragoal。

### §2.3 dev server / 环境 pre-flight

per memory `feedback_dev_server_port_check.md`：

```bash
lsof -i :3000 | head -3    # OrbStack 容器是否占用
# 如占用，pnpm dev 会跳 3001；curl :3000 拿的是容器旧 build
```

T-37 需要 pgvector + Postgres：

```bash
docker compose ps | grep -E "postgres|db"
docker compose exec db psql -U postgres -d <dbname> -c "SELECT * FROM pg_extension WHERE extname='vector';"
# 应该返回 1 row（vector ext 已装）
```

T-66 需要 teaching session API 还在跑：

```bash
grep -A5 "teaching-sessions" app/api/teaching-sessions/*/route.ts | head -10  # 确认路由文件还在
```

### §2.4 Audit-drift baseline acknowledge

启动前 lane subagent prompt 必须含本句：

> "已读 docs/audit/2026-05-27-pre-yuk88-baseline-drift.md。注意：F-01 notes.md 整篇与 ADR-0020 冲突；F-04 src/server/memory/ + src/server/dreaming/ 目录不存在；F-02/F-03 expected baseline（YUK-88 P1 phase 覆盖）。"

---

## §3 Session 起手 ritual（下次接力时跑）

```
我接力 YUK-88 master roadmap Wave 1 execution。
按 docs/superpowers/plans/2026-05-27-wave1-ready-to-launch.md 启动。

执行 §2 4 项 preflight：
1. 修正 YUK-37 Linear + master roadmap §2.2/§11/§0.3 stale 状态
2. ultragoal 简化方案（Wave 1 不动 ledger，只 YUK-88 phase 启动时动）
3. dev server / 环境 check（lsof :3000 / pgvector / teaching-sessions）
4. 读 audit-drift baseline

preflight 全绿后，按 master-roadmap.md §5.1 Wave 1：
- Worktree A: T-37 (per t37-brief-writer-driver.md) → T-88 P0 spike (per yuk88-p0-spike.md)
- Worktree B: T-RA (per tra-rating-advisor-driver.md, YUK-98) → T-66 (per t66-teaching-ask-check-driver.md, YUK-66)

per memory feedback_lane_plan_pattern.md，lane subagent 在 lane start 现场写
per-lane impl plan；driver doc 是 anchor，不预写 impl 步骤。

per memory feedback_subagent_model.md，所有 lane subagent model=opus。

per memory feedback_ui_preflight.md，T-RA + T-66 涉 UI 改的部分必跑
UI design pre-flight（逐字引用 design doc + 等用户 approve）。

Worktree allocation 决策：
- 用 superpowers:using-git-worktrees 建独立 worktree per lane
- worktree A & B 路径 worktrees/wave1-{a,b}-{track}/
- 每条 lane 一条 worktree（不复用）

启动 worktree A：T-37 lane subagent，模型 opus，prompt 含
worktree path / driver doc path / pre-flight context / audit baseline 引用。

启动 worktree B：T-RA lane subagent，模型 opus，prompt 同上。

启动后等 lane subagent 报告。期间 master coordinator 不亲手 impl，
只做 cross-track audit / Linear updates / status check。
```

---

## §4 Wave 1 退出条件

下列全绿才进 Wave 2：

| 条件 | Verification |
|---|---|
| T-37 ship | YUK-37 truly close + commit `Closes YUK-37` + src/server/memory/{client,brief,scope_tagger,triggers}.ts 全在 + Mem0 spike PR description |
| T-88 P0 ship | spike branch + PR description with split/merge/mark_wrong/idle invariant 验证 snapshot + ADR-0020 微调建议（如有） |
| T-RA ship | YUK-98 close + src/server/review/rating-advisor.ts + RatingAdvisor.tsx + 6 boundary unit test |
| T-66 ship | YUK-66 close + question.source=teaching_check + e2e attempt→mistake→variant 链通 + arch.md cleanup |
| Wave gate | pnpm typecheck && lint && audit:* && test && build 全绿 + `/audit-drift` 跑一次 |
| Track-1 phase closure | Track-1 follow-up project 在 Linear 所有 issue Done |
| Master roadmap update | §0.3 当前快照 + §5.1 Wave 1 ✅ 行 + §11 T-37/T-RA/T-66 cards update |
| 用户 retrospective | 决定启 Wave 2（per Q5 rolling commitment） |

---

## §5 Open issues / risk flags（启动前需用户拍板）

### §5.1 高优先

1. **YUK-37 estimate 校正**：3pt→13pt 后 Wave 1 估时从 4 周升 5 周；可接受吗？或者要不要 split T-37 自己（先 client + spike，后 brief + triggers）？
2. **Push 当前 5 commit 到 origin**：现在 push？还是 Wave 1 ship 之后再 push 整批？建议 Wave 1 ship 之后整 PR 走 review。
3. **Audit P1 findings 处理时机**：F-04 forward-locks Dreaming —— 是 T-37 ship 之后立即 ack 在 master roadmap？还是等更大 status.md update window？

### §5.2 中优先

4. **Wave 1 真启动时间**：今天就启？还是等明天 fresh session？lane subagent 跑 long-running impl 会消耗大量 token，建议起手前 review token budget。
5. **YUK-98 issue body 已含 master-roadmap doc 链接**，但 push 前 GitHub link 是 404。如何处理？两个选项：
   - (a) 现在 push 5 commit 让 Linear 链接 live
   - (b) 接受 Linear body 404 几天，YUK-98 实施时再修
6. **ultragoal simplification**：§2.2 推荐"Wave 1 不动 ledger"，但 master roadmap §6 强调 per-track ledger。冲突如何决？建议简化方案先跑，Wave 2 再上完整 multi-ledger。

### §5.3 低优先 / 已捕获

7. F-N1..N6 audit 新发现 6 项 → 推荐 3 个 P4 sweep ticket（per audit §"推荐 P4 doc sweep ticket 目标"）—— 不阻塞 Wave 1
8. v0.4 §11 stale items（#4 "5+ 周无 implementation" 已 stale）—— 进 P4 sweep
9. Token cost 估算：Wave 1 ~5 周 × 2 worktree opus = 真实 token 消耗可观 —— 月度 review at G-cost gate

---

## §6 接力清单（compaction-safe）

如果当前 session compact 或新 session 接力，**必读这 6 个 doc**（按顺序）：

1. `docs/superpowers/plans/2026-05-27-master-roadmap.md` —— 整体战略
2. **本文档** `2026-05-27-wave1-ready-to-launch.md` —— 启动 checklist
3. `docs/superpowers/plans/2026-05-26-yuk88-autonomous-driver.md` —— skill/MCP/behavior 共用规则
4. `docs/audit/2026-05-27-pre-yuk88-baseline-drift.md` —— 启动前必 ack 的 baseline
5. `docs/superpowers/plans/2026-05-27-t{37,ra,66}-*-driver.md` —— Wave 1 内特定 track 启动时
6. `docs/superpowers/plans/2026-05-26-yuk88-p0-spike.md` —— T-88 P0 lane plan

---

## §7 维护规则

- Wave 1 启动后本 doc 标 ⏳ in-flight
- Wave 1 ship 后本 doc 标 ✅ archived
- 后续 wave 各写自己的 ready-to-launch artifact list（命名 `2026-XX-XX-wave{N}-ready-to-launch.md`）
- master-roadmap.md §0.3 当前快照同步 update

---

**End of Wave 1 Ready-to-Launch v1**

> 状态：~~ready-to-launch as of 2026-05-27~~ → **✅ archived 2026-05-27**（同日 ship 完，全部 4 track + 3 个 post-ship P1 fix 全部进 main）

---

## §8 Ship outcome（2026-05-27 18:30）

### §8.1 Ship 顺序与 commit

```
caccd97  YUK-37  T-37 brief writer integration            (lane/t37-brief-writer → main)
aaa534c  YUK-98  T-RA RatingAdvisor UI wiring             (lane/t-ra-rating-advisor → main)
c320446  YUK-66  T-66 teaching ask_check question persist (lane/t66-teaching-ask-check → main)
719c2b7  YUK-90  T-88 P0 TipTap spike                      (spike/yuk-90-tiptap-block-tree, PR #162, per design 不进 main)
─── post-ship audit-drift incremental run → 3 P1 silent dead path ───
f5e27ef  YUK-99   W-A: brief writer event ingest enqueue + env doc (W-01/W-04/W-06 fix)
013a9ad  YUK-100  W-B: RatingAdvisor cause SoT wiring               (W-05 fix)
```

### §8.2 §4 退出条件 verification

| 条件 | 状态 | 证据 |
|---|---|---|
| T-37 ship | ✅ | YUK-37 Done / src/server/memory/{client,brief,scope_tagger,triggers}.ts 全在 / spike findings doc + PR #159 |
| T-88 P0 ship | ✅ | YUK-90 In Review / PR #162 含 4 invariant snapshot + ADR-0020 split-id-preserve 微调建议 / spike branch CI 全绿 |
| T-RA ship | ✅ | YUK-98 Done / rating-advisor.ts + RatingAdvisor.tsx + 14 boundary test (远超 6 要求) |
| T-66 ship | ✅ | YUK-66 Done / question.source=teaching_check + attempt→mistake→variant 链通 via embedded-check/attempt 复用 + arch.md cleanup |
| Wave gate | ✅ | typecheck/lint/audit:{schema,partition,profile}/test/build 全绿，998+1004 unit/DB test + 10 migration smoke + audit-drift 跑一次 |
| Track-1 phase closure | ⏳ | Track-1 follow-up project Linear 仍有 backlog 子项；不阻塞 Wave 1 ship |
| Master roadmap update | ⏳ | status.md 同步在本次 closeout commit；master-roadmap.md §0.3/§5.1/§11 留 next session sweep |
| 用户 retrospective | ⏳ | 用户拍板 Wave 2 时点 |

### §8.3 Post-ship audit-drift findings

完整报告：`docs/audit/2026-05-27-wave1-postship-drift.md`。

**已修（合并 commit f5e27ef + 013a9ad）**：
- W-01 ❌ ADR-0017 event-ingest 触发器没 wire to event writer → `writeEvent` 现在 fire-and-forget enqueue
- W-04 ⚠️ .env.example 缺 OPENAI_API_KEY + 6 MEM0_* → 已补全 + README setup 段
- W-05 ⚠️ advice/submit route 不传 causeCategory（YUK-98 立项目标 silent dead code）→ 已读 CC-1 SoT helper 并 thread ctx
- W-06 ⚠️ meta:orchestrator_self chat-derived trigger 同 W-01 根因 → W-01 fix 自动激活

**留 follow-up（非 Wave 1 blocker）**：
- W-02 P3 driver doc T-37 §4 templates 路径与实装 mismatch → 合并到 P4.8 doc sweep
- W-07 phase-deferred Mem0 Chinese embedding 召回测试 → 启 worker 跑一次 spike recall probe 后追评

**baseline 15 finding 增量结论**：F-04 + F-RA P3 已 resolved；F-01/02/03/06-15 维持原状（YUK-88 / P4.8 sweep 范围）。

### §8.4 经验教训

- **Lane subagent 报告习惯**：subagent 启动 background ops 后倾向"等通知然后退出"，master coordinator 收不到内部 background；建议 lane prompt 显式要求 "wait until all background ops complete, only then return"，或 master 直接进 worktree 跑 closeout gate。本次两次 SendMessage 仍未拿到完整 report，最终 master 接管 worktree commit / merge。
- **audit-drift incremental 高价值**：baseline + incremental 双 sweep 在 8 小时内发现 3 个 P1 silent dead path，"做了 80% 剩 20% 没收口" 是典型 ship 漏；推荐每 wave ship 后跑一次 incremental。
- **多 lane chain-merge 顺序**：W-A → main ff → W-B rebase onto new main → ff，linear history 保留。Lane plan + commit message 互引 audit finding 编号，git history 自带 traceability。

---

**End of Wave 1 closeout v1**
