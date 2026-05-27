# T-37 Brief Writer Phase B — Track Driver

> Wave 1 track driver。复用 master-roadmap + YUK-88 driver 共用规则（skills / MCP / 行为 / failure / hard NO），本 doc 仅 per-track 特异。

**Doc 日期**：2026-05-27
**Track ID**：T-37
**Linear**：[YUK-37](https://linear.app/yukoval-studios/issue/YUK-37) ⚠️ **status 错标 Done，实际未实施**（见 §0.2）
**Source spec**：[ADR-0017](../adr/0017-memory-mem0-plus-brief-layer.md) + [ADR-0015 §2](../adr/0015-learning-record-memory-brief.md)
**Estimate**：~13 pt（per YUK-37 acceptance 7 项实施项，**非 master roadmap §11 T-37 card 写的 5pt**）
**Worktree**：A
**Owner**：lane subagent (model=opus)

---

## §0 状态校准

### §0.1 跟 master roadmap 的关系

- master roadmap §2.2 T-37 card 写 "🟡 in progress, ~5pt 剩"
- **实际**：`src/server/memory/` 目录不存在；PR #102/#103 commit body 明示 "实施段待做"；Linear status 错置 Done

### §0.2 Discrepancy 处理

Wave 1 启动前必跑：
1. **Reopen YUK-37 to In Progress**（手动 flip via Linear）—— commit message 不能 `Closes YUK-37` 直到全部 acceptance 项 done
2. **Update master roadmap §2.2 + §11 T-37 card**：5pt → 13pt；status "🟡 in progress" → "⬜ pending 实施"
3. **Update Wave 1 估时**：4 周 → 5 周（worktree A 节奏由 T-37 决定）

---

## §1 Scope（per YUK-37 acceptance）

### §1.1 必交付项（7 个，每项独立可 verify）

1. **Mem0 spike inline**（~2-3h before commit）—— verify Mem0 TS SDK + pgvector adapter on current OSS version; verify LLM provider swap to xiaomi/mimo; verify Chinese embedding quality on PoC dataset
2. **`src/server/memory/client.ts`** —— Mem0 client wrapper，single-owner write path for fact layer
3. **`src/server/memory/brief.ts`** —— brief regen routine，single-owner write path for brief layer（满足 ADR-0015 §2 forward lock）
4. **`src/server/memory/scope_tagger.ts`** —— `computeAffectedScopes(event_partial)` helper；从所有 event writer 调用
5. **`src/server/memory/triggers.ts`** —— pg-boss subscribers for event-tagged regen + chat-derived `mem0.add()` + cron daily sweep
6. **Per-prefix brief templates** —— 5 fixed scope prefix（global / subject:* / topic:* / mistake_cluster:* / meta:orchestrator_self）的 markdown 模板
7. **Anti-storm** —— pg-boss singletonKey dedup on regen jobs + SoT diff threshold in brief regen handler

### §1.2 已 ship 的前置（不重做）

- ✅ ADR-0017 accepted (PR #103) —— dual-layer 架构契约
- ✅ pgvector extension in docker-compose Postgres
- ✅ `memory_brief_note` table schema (drizzle migration 已 ship at Foundation 段)
- ✅ `event.affected_scopes` text[] column

### §1.3 Out of scope（明确不做）

- ❌ Orchestrator 建设（src/server/orchestrator/* —— 独立 phase）
- ❌ Dreaming agent 周期性 refresh brief（T-DR 的事）
- ❌ Mem0 user_id 多用户（ADR-0007 永久 single-user）
- ❌ 改 event 表 immutability（ADR-0006 v2）
- ❌ 改 knowledge_mastery view（ADR-0012）

---

## §2 Acceptance criteria

- [ ] Mem0 spike notes 在 PR description 里（含 SDK 验证 / pgvector / xiaomi LLM swap / Chinese embedding 4 项）
- [ ] `src/server/memory/client.ts` + integration test（Mem0 add/search round-trip on real container）
- [ ] `src/server/memory/brief.ts` + unit test（LLM mocked）
- [ ] `src/server/memory/scope_tagger.ts` + unit test
- [ ] `src/server/memory/triggers.ts` + pg-boss subscriber registration
- [ ] 5 个 scope prefix 的 brief templates（markdown 内嵌于 brief.ts 或独立 .md）
- [ ] Anti-storm singletonKey + SoT diff threshold 实装
- [ ] Mem0 `user_id = 'self'` invariant test
- [ ] `pnpm test` + `pnpm typecheck` + `pnpm lint` + `pnpm audit:schema` + `pnpm audit:partition` + `pnpm audit:profile` + `pnpm build` 全绿
- [ ] PR title `feat(memory): Mem0 + brief layer integration — Phase B (YUK-37)`
- [ ] Commit message ends with `Closes YUK-37`（Linear auto-flip Done）

---

## §3 Pre-flight（lane start 必跑）

1. **Reopen YUK-37**（手动 flip Linear status to "In Progress"）
2. **Update master-roadmap.md §2.2 / §11 T-37 card pts + status**（错标 Done 修复）
3. **Check Mem0 npm package latest version**：`pnpm view mem0ai version` —— 确认 SDK 仍 active 维护
4. **Check pgvector container extension**：`docker compose exec db psql -c "SELECT * FROM pg_extension WHERE extname='vector'"` —— 确认 ext 在
5. **`src/server/memory/` 目录不存在确认**（不破坏既有 import）：`ls src/server/memory/ 2>/dev/null || echo OK clean slate`
6. **`event.affected_scopes` column 存在确认**：`grep affected_scopes src/db/schema.ts`

---

## §4 Files touched（预期）

```
src/server/memory/
  client.ts        # Mem0 wrapper（新，~150 行）
  brief.ts         # brief regen（新，~250 行）
  scope_tagger.ts  # computeAffectedScopes helper（新，~80 行）
  triggers.ts      # pg-boss subscribers（新，~150 行）
  templates/
    global.md          # brief template per scope prefix
    subject.md
    topic.md
    mistake_cluster.md
    meta_orchestrator.md
docker-compose.yml  # (if pgvector needs version bump)
package.json        # +mem0ai dep
tests/server/memory/
  client.test.ts          # integration test
  brief.test.ts           # unit (LLM mocked)
  scope_tagger.test.ts    # unit
  triggers.test.ts        # pg-boss handler test
```

不动既有文件，除非：
- `src/server/events/queries.ts` —— 加 affected_scopes 写入 hook（如果 event writer 还没传 affected_scopes）
- `package.json` + `pnpm-lock.yaml` —— mem0ai dep

---

## §5 Forward-locks

- T-DR Dreaming Lane —— consumer of brief writer
- T-D2 read tools `query_memory_brief` —— consumer
- T-D6 Phase 3 Global Coach —— consumer

T-37 是 P0 critical path 关键 trigger。任何延期 compound 推 T-DR / T-D6 schedule。

---

## §6 Risks

| Risk | Mitigation |
|---|---|
| Mem0 TS SDK 已 stale / 不支持 latest pgvector | spike 阶段先验；如确认 stale，escalate ADR-0017 revision（可能要换 fact 层方案） |
| Chinese embedding 质量低 | spike 阶段对 PoC 34-event 测召回；如 < 60% recall，escalate 选 embedding model |
| Mem0 内部 LLM 调用绕过 xiaomi provider | spike 验证 SDK 是否支持自定义 LLM；如不支持，要么自己包 Mem0 / 要么换 fact 方案 |
| pg-boss singletonKey + SoT diff anti-storm 实测打不住 | 加 hard rate limit（每 brief scope 6min 内只跑 1 次） |
| brief regen LLM 调用成本高 | event-tagged trigger 只 schedule 不立即跑；cron sweep 合并同 scope 多 trigger |

---

## §7 Skills / MCP usage（cross-track delta）

- `superpowers:test-driven-development` —— Mem0 client + brief writer 双 path，TDD 严守
- `mcp__context7__query-docs` —— Mem0 + pgvector API 必查（不靠 memory）
- `mcp__auggie__codebase-retrieval` —— scope_tagger 接入点 search（哪些 event writer 需要传 scopes）

其他 common rules 见 YUK-88 driver §4-§5。

---

## §8 后续 follow-up（不在本 driver 内）

- Dreaming agent 周期性刷新 brief（T-DR / Wave 4）
- `query_memory_brief` read tool 接入 Copilot drawer（T-D2 / Wave 2）
- per-hub opt-in brief / long-term stale 规则（v0.4 §6 P5 brainstorm spec）
