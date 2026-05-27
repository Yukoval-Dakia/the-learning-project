# T-RA RatingAdvisor — Track Driver

> Wave 1 quick-win track driver。复用 master-roadmap + YUK-88 driver 共用规则。

**Doc 日期**：2026-05-27
**Track ID**：T-RA
**Linear**：[YUK-98](https://linear.app/yukoval-studios/issue/YUK-98) — Backlog，Track-1 Follow-up project，M2 milestone，3pt Medium（created 2026-05-27）
**Source spec**：[`docs/superpowers/specs/2026-05-22-foundation-true-closeout-design.md`](../superpowers/specs/2026-05-22-foundation-true-closeout-design.md) §P3 partial credit rating advisory
**Estimate**：3 pt
**Worktree**：B (Wave 1)
**Owner**：lane subagent (model=opus)

---

## §0 状态校准

### §0.1 跟 master roadmap 的关系

- master roadmap §2.4 P1.5 + §11 T-RA card 一致：3pt，Track-1 follow-up W2.1，无 Linear issue
- 实际：Linear 上 Track-1 follow-up project 已存在；M2 milestone 已存在；缺独立 sub-issue

### §0.2 Linear issue body 草稿（创建时用）

```
Title: T-RA Partial credit P3 RatingAdvisor + rating-advisor.ts
Project: Track-1 Follow-up — Note / Teaching / Review polish
Milestone: M2 — Note / Teaching / Review 深化
Parent: (none，作为 leaf issue)
Priority: Medium
Estimate: 3 pt
Description: see body section below
```

---

## §1 Scope

### §1.1 必交付项

1. **`src/server/review/rating-advisor.ts`** —— 输入 `JudgeResultV2` → 输出 `{ suggested_rating, reason_md }` 三档纯函数
   - 0.0-0.4 → `{ rating: 'again' | 'hard', reason: 'low score, partial' }`
   - 0.4-0.7 → `{ rating: 'good' | 'easy', reason: 'mostly correct' }`
   - 0.7-1.0 → `{ rating: 'easy' | 'good', reason: 'strong' }`
   - cause 类别影响（per CC-1 cause precedence）：carelessness → 倾向 'good'；conceptual_error → 倾向 'again'
2. **`app/api/review/submit/route.ts`** —— body schema 加 optional `judge_result_v2: JudgeResultV2` 字段（渐进迁移；老 client 不传仍 work）
3. **`src/ui/review/RatingAdvisor.tsx`** —— review feedback 阶段渲染 advisor 卡片"模型建议 X，你可改"
4. **User override path**：用户最终 rating 仍 user-overridable（不动现有 CC-1 cause precedence）；advisor 仅 informational

### §1.2 Out of scope

- ❌ 改 FSRS scheduling（advisor 只影响 user rating UX，不影响调度逻辑）
- ❌ 改 cause precedence（CC-1 invariant 不动）
- ❌ Server-side auto-rate（advisor 永远只是建议，不自动 commit rating）
- ❌ Multimodal judge score interpretation（current scope 限文本 / steps@1 / exact / keyword / semantic 已覆盖）

---

## §2 Acceptance criteria

- [ ] `rating-advisor.ts` 三档映射纯函数 + unit test 覆盖 6 个边界 case（0.0 / 0.4 / 0.7 / 1.0 / score=0.4 + carelessness / score=0.4 + conceptual）
- [ ] `app/api/review/submit/route.ts` body 增 `judge_result_v2` optional 字段；老 client 仍 work
- [ ] `<RatingAdvisor>` 在 review feedback 阶段显示 advisor 卡片
- [ ] User override 走原 rating 路径；advisor 仅 informational（不自动 commit）
- [ ] CC-1 cause precedence helper 仍是唯一 cause SoT；advisor 读 cause 走 helper 不自查
- [ ] `pnpm test:unit` + `pnpm test:db` + `pnpm typecheck` + `pnpm lint` + `pnpm audit:schema` + `pnpm build` 全绿
- [ ] PR title `feat(review): RatingAdvisor for partial credit P3 (YUK-XX)` (YUK-XX = 建好的 Linear issue ID)
- [ ] Commit message ends with `Closes YUK-XX`

---

## §3 Pre-flight

1. **Create Linear issue** per §0.2 body 草稿；获取 YUK-XX ID
2. **Verify JudgeResultV2 contract**：`grep -A5 "scoreMeaning" src/core/schema/capability.ts` —— 确认 v2 schema 在 + 字段名稳定
3. **Verify CC-1 helper 接口**：`grep -A3 "effectiveCauseForFailureAttempt\|effectiveCauseCategoryForFailureAttempt" src/server/events/cause-policy.ts`
4. **Verify `/review` submit route 当前 body schema**：`Read app/api/review/submit/route.ts` —— 确认 optional 字段加法不破老 client
5. **UI design pre-flight**（per CLAUDE.md UI Design Compliance）：
   - 逐字引用 design doc 段落（`docs/design/2026-05-15-design-brief-v2.1.md` § rating advisory if exists；否则 cite §1.6 Copilot + extension to review surface）
   - 声明组件类型：**inline card** 在 review feedback 阶段（非 modal / drawer）
   - 列出 touch 文件：`src/ui/review/RatingAdvisor.tsx`（新）+ `app/(app)/review/page.tsx`（嵌入）
   - **等用户 approve 才动 UI 代码**

---

## §4 Files touched（预期）

```
src/server/review/
  rating-advisor.ts        # 新，~80 行
tests/server/review/
  rating-advisor.test.ts   # 新，~100 行（6+ case）

app/api/review/submit/route.ts  # 改：body schema 加 judge_result_v2 optional

src/ui/review/
  RatingAdvisor.tsx        # 新，~60 行
app/(app)/review/page.tsx  # 改：feedback 阶段嵌入 <RatingAdvisor>（等 UI pre-flight approve）
```

---

## §5 Forward-locks

无外部 forward-lock。T-RA 是 leaf track，Wave 1 quick-win，不 block 后续 wave。

---

## §6 Skills / MCP usage

- `superpowers:test-driven-development` —— pure function 三档映射 + boundary cases
- UI design pre-flight per CLAUDE.md（hard requirement）
- 无 context7 / auggie 需要（在内场修改既有 review 路径，符号都已知）

---

## §7 Risk

| Risk | Mitigation |
|---|---|
| advisor 建议跟 user 实际想法 diverge 大，UX 干扰 | optional 字段渐进；user override 永远优先；UX 测试期可加 toggle off |
| `judge_result_v2` 字段在 server submit body 但 client 不传 | body 字段 optional + defaults；老 client 0-impact |
| CC-1 cause helper 接口变化导致 advisor 读 cause 失败 | helper signature 锁定 in YUK-51 PR；regression 测覆盖 |
