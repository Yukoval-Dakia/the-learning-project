# RESUME — 2026-05-15 晚 / 下个 session ramp-up

> 上一个 session 关掉是为了让 github-oauth MCP 重启时跑 OAuth flow。本文档 5 分钟内让新 session 接续。**读完即删本文件**（git rm RESUME.md）。

## 今日已完成（main 已 push）

```
f5baf43  Phase 1c.1 Step 2 refresh — Zod discriminated union
21362a1  schema 防漂移 lint（pnpm audit:schema）
44fc8c7  Phase 1c.1 Step 1 refresh — schema DDL + view + DROP
eaab653  data-assumptions follow-up
fef0c63  ADR-0012 — mastery → derived view
76cf87d  ADR-0011 — tool_use + chip + edge events
5afef73  v2.1 brief 吸收 designer 第二轮反馈
df03cc9  v2.1 brief 6 处 refine + mesh + tool-use
```

## 当前推荐路径状态

已完成 E.1 / E.2 / E.3 + 防漂移 lint + Phase 1c.1 plan refresh（Step 1 + Step 2）。

**两个开放决策**（上次没收到 ack）：

1. **Phase 1c.1 启动模式**：单线（20-27d）vs 并行 3 subagent（8-12d）vs 混合（Step 1+2 并行 → 单线 3/4/5）
2. **GitHub MCP**：等本次 OAuth 验证完，决定是否替代 333 次 Bash gh 调用

## GitHub MCP 当前配置

- `plugin:github:github` —— 旧的，仍 Failed（需 GITHUB_PERSONAL_ACCESS_TOKEN env，没给）—— 留着无害
- `github-oauth` —— 上次加的 HTTP MCP at `api.githubcopilot.com/mcp/`，**新 session 启动时会触发 OAuth 浏览器流**
- 期待结果：授权后 ✓ Connected，工具表多 ~30 个 (issues / PRs / Actions / repos)
- Fallback：Free Copilot 若不含 MCP → 失败 403 → 回退 classic PAT（用户手里有）

## 验证 OAuth 落地后第一件事

```bash
claude mcp list 2>&1 | grep github-oauth
# 期望: github-oauth: ... ✓ Connected
```

成功后让 Claude 跑：
1. List open PR / issue / 最近的 Actions run
2. 检查 sub-0c-implementation 分支是否还存在 / CI 状态
3. 看 dependabot 现在还剩几个漏洞（之前 7 个，merge 了 drizzle PR #31）

## 当前 designer 进度

- v2.1 brief 已发（commit eaab653）含 6 处 refine + mesh + tool-use + designer 反馈第二轮
- designer 在跑 Claude Design 第二轮，输出到 `docs/design/loom-design-v2.1/`
- 第三轮 trigger：data-assumptions §Q1 "归因中" KPI 假设 attribution 异步——当前同步。**待 v2.1 落地后处理**

## 阻塞 / 待做

- [ ] Phase 1c.1 启动模式决策（用户选 A/B/C）
- [ ] GitHub MCP OAuth 验证
- [ ] （deferred）Phase 1c.1 Step 3-13 inline refresh
- [ ] （deferred）designer v2.1 第三轮（attribution 异步化）

## 关键文件（按读取顺序）

1. `docs/adr/0011-tool-use-and-edge-event-paths.md`（5 个新 event 路径 Zod）
2. `docs/adr/0012-mastery-as-derived-view.md`（mastery → PG view）
3. `docs/design/2026-05-15-data-assumptions.md`（数据假设清单，含 audit 结果）
4. `docs/superpowers/plans/2026-05-14-phase1c1-encounter-session-ui-scaffold.md`（已 refresh banner + Step 1 + Step 2）
5. `docs/design/2026-05-15-design-brief-v2.1.md`（designer 第二轮 brief）
6. `scripts/audit-schema-writes.ts` + `audit-schema-allowlist.json`（防漂移 lint，50 allowed stubs 含 reason + resolves_when）

## 关键 ACK 自上次 session

- 用户明确 mastery 走 derived view 方向（决策 3 = B）
- 用户接受 ADR-0011 5 处 event 路径追认（决策 4 = A）
- 用户对**单线 vs 并行**没 ack——等本次 session 重启后决定
- 用户对**死字段批量清理**没 ack——allowlist 50 entries 暂留待 1c.1 同步 DROP

---

下个 session 开场建议命令：
```
读 RESUME.md，然后 claude mcp list 看 github-oauth 状态
```
