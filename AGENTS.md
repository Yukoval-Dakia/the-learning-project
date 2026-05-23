# AGENTS.md instructions for /Users/yukoval/yukoval-projects/the-learning-project

- 始终以中文为主回复；即便用户用英文提问，也默认中文回答。除非用户明确要求使用其他语言。
- Issue tracker 用 Linear：PR / commit 写 `YUK-XX`，分支优先用 Linear 的 `yuk-xx-...` 格式；新工作不要用裸 `#N`。详细规则见 `docs/agents/issue-tracker.md`。
- Codex 项目级 hooks 在 `.codex/hooks.json`，镜像 Claude 侧 `.claude/settings*.json` 关键约束（直接复用 `.claude/hooks/*` 脚本，不重复实现）：
  - 编辑 JSON 前 (`.codex/hooks/codex-apply-patch-json-guard.mjs`) + 后 (`codex-post-edit-check.mjs`) 保持可解析
  - 编辑 TS/JS 后对 touched files 跑 Biome
  - Bash 中禁止危险 git 操作 (`.claude/hooks/git-guard.mjs`)：force push、force delete branch、main/master 上 commit、force remove worktree
  - Linear-tracked branch (yuk-*/foundation-*/p\<N\>-*) 上 commit 必须含 `YUK-NN`，多个 issue 必须逐个重复 Linear keyword（例如 `Closes YUK-27` + `Closes YUK-28`，不要写 `Closes YUK-27 + YUK-28`）(`.claude/hooks/linear-guard.mjs`)
  - `git fetch` / `git pull` 后 echo upstream divergence + 上游 author (`.claude/hooks/post-fetch-divergence.sh`)
- ⚠️ Codex 当前不支持 Stop event hook —— Claude 侧的 `linear-closeout-reminder.sh` (Stop hook) 在 codex 会话里**不会自动跑**。codex 会话交付前请手动按 `docs/agents/issue-tracker.md` "Closeout issue capture gate" 检查 Linear 状态同步。
- 如果 hooks 尚未被当前 Codex 会话加载或 trust，仍需手动遵守上述约束，并在交付前对 touched files 运行等价检查。

<!-- context7 -->
Use Context7 MCP to fetch current documentation whenever the user asks about a library, framework, SDK, API, CLI tool, or cloud service -- even well-known ones like React, Next.js, Prisma, Express, Tailwind, Django, or Spring Boot. This includes API syntax, configuration, version migration, library-specific debugging, setup instructions, and CLI tool usage. Use even when you think you know the answer -- your training data may not reflect recent changes. Prefer this over web search for library docs.

Do not use for: refactoring, writing scripts from scratch, debugging business logic, code review, or general programming concepts.

## Steps

1. Always start with `resolve-library-id` using the library name and the user's question, unless the user provides an exact library ID in `/org/project` format
2. Pick the best match (ID format: `/org/project`) by: exact name match, description relevance, code snippet count, source reputation (High/Medium preferred), and benchmark score (higher is better). If results don't look right, try alternate names or queries (e.g., "next.js" not "nextjs", or rephrase the question). Use version-specific IDs when the user mentions a version
3. `query-docs` with the selected library ID and the user's full question (not single words)
4. Answer using the fetched docs
<!-- context7 -->
