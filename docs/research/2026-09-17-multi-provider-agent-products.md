# 多 provider agent 产品调研：opencode / Hermes Agent / 周边参考

> **出处说明（YUK-1030 恢复）**：本稿 2026-09-17 写于 `feat/skill-fixture` 分支
> （commit `42e9a5a3d`），是 `docs/design/2026-09-18-pi-agent-execution-adapter.md`
> 引用的调研底稿，当时未随 fixture 打捞合入 main；现按原样恢复以保持引用可解析。
> 注意「动机」一段描述的是调研时点（SDK 时代）现状——Claude Agent SDK 已随
> YUK-1025 退役，`PiAgentAdapter` 为唯一执行引擎。

> **类型**：外部产品调研（research，非本项目设计/实现文档）
> **日期**：2026-09-17
> **调研对象**：`sst/opencode` @ dev（HEAD `5a83358`，本地 tarball 解包实读）、`NousResearch/hermes-agent` @ main（2026-09-17 clone，246k stars）、`openclaw/openclaw`、`block/goose`、`cline/cline`、`RooCodeInc/Roo-Code`、Aider 官方文档
> **方法**：官方文档 + 克隆/解包源码实读 + `gh api` 文件树核验。所有 file:line 引用来自本地 checkout；文档类主张附官方 URL。
> **动机**：本项目全部 LLM 调用经 `@anthropic-ai/claude-agent-sdk`（spawned `claude` 子进程，mimo Anthropic-compat 端点为默认，`AI_PROVIDER_OVERRIDE=anthropic-sub` 为 Claude Max OAuth 逃生道；wiring 见 `src/server/ai/providers.ts` + `runner.ts`）。owner 在评估是否换掉 Agent SDK，参照物是"多 provider + 插件系统 + 订阅 auth + 按任务路由"的产品。

---

## 0. 执行摘要

1. **opencode 的架构 = "models.dev 目录 + Vercel AI SDK 适配包 + 插件化 auth/provider hook + 自研 loop"**。Provider 不是类注册表，而是数据：`models.dev` 快照声明每个 provider 的 `npm` 字段（即哪个 `@ai-sdk/*` 包），`BUNDLED_PROVIDERS` 把包名映射到 `createX` 工厂（`provider.ts:113-126`），自定义 provider 用 `provider.<id>.npm: "@ai-sdk/openai-compatible"` 声明即接入（`docs/providers`）。自定义 fetch 是 OAuth 的注入点——`auth.loader` hook 返回 `{apiKey: dummy, fetch}`，provider 层把它塞进 SDK options（`provider.ts:1608-1627`、`codex.ts:348-437`）。
2. **ChatGPT Plus/Pro OAuth 在 opencode 是内置插件**（`plugin/openai/codex.ts`）：Codex CLI 同一个 public client_id（`app_EMoamEEZ73f0CkXaXp7hrann`）、PKCE + localhost:1455 回调、device-auth 无头路径、token 轮换；运行时把 `/v1/responses` 改写进 `chatgpt.com/backend-api/codex/responses` 并注入 `ChatGPT-Account-Id`。**Claude Pro/Max OAuth 在 1.3.0 被官方移除**——"Anthropic explicitly prohibits this"（docs/providers Anthropic 节）。
3. **"hermes agent" 指 `NousResearch/hermes-agent`**（Nous Research 的个人 agent，Python，~40 个内置 provider profile）。它不是 OpenClaw——README 明确提供 `hermes claw migrate` 从 `~/.openclaw` 导入。它的机制与 opencode 互补：声明式 `ProviderProfile`（`providers/base.py`）+ `api_mode` 传输层分派（`chat_completions | codex_responses | anthropic_messages | bedrock_converse | codex_app_server`）+ **三种 Claude 订阅 auth 路径**（`CLAUDE_CODE_OAUTH_TOKEN` env、读 Claude Code 自己的 credentials/Keychain、自带 PKCE 登录）+ **凭证池**（多账号轮换）。
4. **订阅 auth 的可复制做法有三种形态**，都在生产代码里：(a) **自带 OAuth app**（opencode/goose 的 ChatGPT PKCE + device flow；hermes 的 Claude PKCE）；(b) **借用厂商 CLI 的凭证**（hermes `_import_codex_cli_tokens` 读 `~/.codex/auth.json`、`read_claude_code_credentials` 读 `~/.claude/.credentials.json`/macOS Keychain）；(c) **把厂商 CLI 当 provider**（hermes `codex_app_server`、goose `claude_code.rs`/`*_acp.rs`、OpenClaw `extensions/anthropic`、Cline `ClaudeCodeProvider`——即本项目当前形态）。
5. **对本项目**：Agent SDK 捆绑的不只是 transport，是整个执行核（tool loop、PreToolUse/canUseTool spawn contract、nativeCompaction、`agents` 子代理、session persist/resume、skills 隔离、outputFormat、thinking blocks、Task 生命周期事件）。替换它的真实成本是重建 `runner.ts` 身后这一层；而"多 provider + 订阅 auth"中**只有 ChatGPT Codex 类非 Anthropic 协议 provider 是 SDK 结构上给不了的**。分层的迁移路径见 §5：风险最低的是保留 SDK 作 agentic 核 + 沿 `executeDirectProviderAttempt` 现有 seam 扩出直连 lane；最彻底的是 opencode 式 registry + 自研 loop。

---

## 1. opencode（sst/opencode）

源码基线：`sst/opencode` dev 分支 tarball（2026-09-17 拉取，HEAD `5a83358`），以下 `packages/...` 路径均指该树。官方文档：`https://opencode.ai/docs/`。

### 1.1 Provider 架构：models.dev 目录 + AI SDK npm 适配 + 三层覆盖

**目录层（catalog）**：`packages/core/src/models-dev.ts` 把 `https://models.opencode.ai/api.json`（models.dev 数据镜像；`Flag.OPENCODE_MODELS_URL` 可换源，models-dev.ts:160,175）拉下来缓存到 `~/.cache/opencode/models.json`（5 分钟新鲜度 TTL + 跨进程 flock + 后台 60 分钟周期刷新，models-dev.ts:161-165,241,256）。降级链：磁盘缓存 → 构建期内嵌快照（`OPENCODE_MODELS_DEV` 常量，models-dev.ts:198-199）→ `OPENCODE_DISABLE_MODELS_FETCH` 或 `OPENCODE_MODELS_PATH` 指定的本地文件（models-dev.ts:184-187,222,255）。catalog 里每个 provider 声明 `npm`（用哪个 AI SDK 包）、`api`（base URL）、`env`（认哪些环境变量）、`models`（id → {tool_call, modalities, cost, limit, release_date, family}），见 `provider.ts:1265-1330,1405` 的 `fromModelsDev{Model,Provider}` 转换。

**适配层（wire adapter）**：`BUNDLED_PROVIDERS`（`provider.ts:113-126`）把 npm 包名映射到动态 import + `createX` 工厂：`@ai-sdk/anthropic`、`@ai-sdk/openai`（Responses API）、`@ai-sdk/openai-compatible`（Chat Completions）、`@ai-sdk/google*`、`@ai-sdk/azure`、`@ai-sdk/amazon-bedrock`、`@openrouter/ai-sdk-provider`、`gitlab-ai-provider`、`venice-ai-sdk-provider`、以及自家 copilot 适配。解析在 `resolveSDK`（provider.ts:1734-1862）：catalog 外的 npm 包走 `Npm.add()` 按需安装再 `import()`，取第一个 `create*` 导出（provider.ts:1843-1861）。`options.fetch` 是全程保留的自定义 fetch 注入点，再叠 `headerTimeout`/`chunkTimeout`（AbortController + SSE reader 包装，provider.ts:1798-1828）。

**覆盖顺序**（`provider.ts:1396-1660` 的 layer 初始化）：
1. models.dev catalog → `database`（provider.ts:1405-1407）
2. **plugin `provider` hook**：`hook.provider.models(provider, {auth})` 可整体改写某 catalog provider 的 model 表（provider.ts:1452-1483）
3. **config `provider` 块**：`opencode.json` 里的 `provider.<id>` 深合进 database，每个 model 解析 `api.npm`（`model.provider?.npm ?? provider.npm ?? catalog.npm ?? "@ai-sdk/openai-compatible"`，provider.ts:1485-1580）
4. **env 命中**：catalog 声明的 `provider.env` 变量存在即注入 `source:"env"` + key（provider.ts:1583-1594）
5. **auth.json 命中**：`type:"api"` 的 key 合入 `source:"api"`（provider.ts:1596-1606）
6. **plugin `auth.loader`**：对 stored auth 调 `loader(getAuth, providerInfo)`，返回的 options（含自定义 `fetch`）合并进 provider（provider.ts:1608-1627）
7. **内置 custom loaders**：`custom(dep)` 表（provider.ts:174-…）按 provider id 给 `autoload/getModel/vars/options/discoverModels`——例如 `openai.getModel` 强制 `sdk.responses(modelID)`（provider.ts:209-216）、anthropic 注入 `anthropic-beta` 头（provider.ts:175-184）、`opencode` provider 无 key 时只留免费模型（provider.ts:185-208）
8. config 层再盖一遍 name/env/options（provider.ts:1646-1655）

**加自定义 OpenAI 兼容端点**（docs/providers "Custom provider"）：`/connect` → `Other` 存 key 到 auth.json，然后 `opencode.json`：

```json
{ "provider": { "myprovider": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "My AI Provider",
      "options": { "baseURL": "https://api.x.com/v1", "apiKey": "{env:KEY}", "headers": {} },
      "models": { "my-model": { "name": "My Model", "limit": {"context":200000,"output":65536} } } } } }
```

`npm` 选 `/v1/chat/completions` 用 `@ai-sdk/openai-compatible`、`/v1/responses` 用 `@ai-sdk/openai`；可按 model 级 `provider.npm` 混用（docs/providers Troubleshooting 节）。模型能力字段（tool_call/modalities/limit/whitelist/blacklist）同样在 config 层声明。

### 1.2 Auth：auth.json + 插件 AuthHook + 内置订阅流

**存储**：`~/.local/share/opencode/auth.json`（`Global.Path.data`，`auth/index.ts:10`），写入 0o600（auth/index.ts:79,88）。schema 是带 `type` 判别式的 union（auth/index.ts:15-31）：
- `{type:"oauth", refresh, access, expires, accountId?, enterpriseUrl?}`
- `{type:"api", key, metadata?}`
- `{type:"wellknown", key, token}`——`opencode providers login <url>` 走 `.well-known/opencode` 拉组织级 config + spawn 声明的 auth command 取 token（`cli/cmd/providers.ts:300,328`）。

`OPENCODE_AUTH_CONTENT` env 可整份注入（auth/index.ts:59-61）——容器/CI 免文件。

**入口**：TUI `/connect`；CLI `opencode providers login|list|logout`（`cli/cmd/providers.ts:300,492`；文档仍写 `opencode auth login`，`cli/error.ts:105` 表明 alias 仍在）。login 流程对 plugin `auth.methods` 逐个跑：method 选完 → `authorize()` 返 `{url, instructions, method:"auto"|"code", callback}` → callback 拿 `{refresh,access,expires,accountId}` 或 `{key,metadata}` 存入 auth.json（`packages/plugin/src/index.ts` 的 `AuthHook`/`AuthOAuthResult` 类型；`cli/cmd/providers.ts:46-141`）。

**内置 auth 插件**（`plugin/index.ts:67-80` `internalPlugins`）：`CodexAuthPlugin`（ChatGPT）、`CopilotAuthPlugin`（GitHub Copilot）、Modal、GitLab、Poe、Cloudflare Workers/AI Gateway、Azure、DigitalOcean、Snowflake Cortex、xAI、Cerebras。

**ChatGPT Plus/Pro（Codex）路径**（`plugin/openai/codex.ts`）：
- 常量（codex.ts:10-16）：`CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"`（Codex CLI 的公共 client）、`ISSUER = https://auth.openai.com`、`CODEX_API_ENDPOINT = https://chatgpt.com/backend-api/codex/responses`、`OAUTH_PORT = 1455`。
- **浏览器流**（"ChatGPT Pro/Plus (browser)"，codex.ts:441-468）：S256 PKCE → `auth.openai.com/oauth/authorize?...&codex_cli_simplified_flow=true&originator=opencode`（:88-101）→ localhost:1455 起一次性 HTTP server 收 `/auth/callback` 的 code+state（:164-237）→ `POST /oauth/token` 换 {id_token, access_token, refresh_token}（:117-133）。state 校验防 CSRF，5 分钟超时。
- **无头流**（"ChatGPT Pro/Plus (headless)"，codex.ts:472-540+）：`POST /api/accounts/deviceauth/usercode` 拿 device_auth_id+user_code → 用户到 `auth.openai.com/codex/device` 输码 → 轮询 `/api/accounts/deviceauth/token` → 再换 authorization_code → `/oauth/token`（redirect_uri `${ISSUER}/deviceauth/callback`，:522-523）。
- **运行时**（`auth.loader`，codex.ts:329-437）：返回 `{apiKey: OAUTH_DUMMY_KEY, fetch}`（:349）；自定义 fetch 每次调用先 `getAuth()`，access 过期则单飞 `refreshAccessToken`（refresh_token grant，:135-149）并 `client.auth.set` 回写；随后剥掉原 Authorization、注入 `Bearer <access>` + `ChatGPT-Account-Id`（accountId 在登录时从 id_token JWT claim `chatgpt_account_id` 提取，:38-78,416-418）、把路径含 `/v1/responses` 或 `/chat/completions` 的请求**改写到 `chatgpt.com/backend-api/codex/responses`**（:420-425），residency claim 存在时加 `x-openai-internal-codex-residency`（:426）。可选 WebSocket 传输（`experimentalWebSockets` → `OpenAIWebSocketPool`，:434）。
- **模型过滤**（`provider.models` hook，codex.ts:288-327）：仅当 auth 是 oauth 时把 catalog 的 openai 模型表裁到 Codex 允许集——`ALLOWED_MODELS` 显式集（gpt-5.5/gpt-5.3-codex-spark/gpt-5.4/gpt-5.4-mini）+ 版本模式放行 `major>5 || (major==5 && minor>4)`，显式剔除 `gpt-5.5-pro`/`gpt-5.6`/`reasoningMode:"pro"`；cost 全置 0（订阅不计价），并覆写 limit（gpt-5.5/5.6 → 400k context/272k input/128k output）。
- **参数整形**：`chat.headers` 注入 `originator: "opencode"`、`User-Agent: opencode/<ver>`、`session-id`；`chat.params` 把 `maxOutputTokens` 置 undefined（"Match codex cli"）；request prep 对 OAuth lane 把 system prompt 合进 `instructions` 字段而非 system message（`session/llm/request.ts:57,99`）。

**Claude Pro/Max**：**官方已移除**。docs/providers Anthropic 节原文："There are plugins that allow you to use your Claude Pro/Max models with OpenCode. Anthropic explicitly prohibits this. Previous versions of OpenCode came bundled with these plugins but that is no longer the case as of 1.3.0."——即 1.3.0 之前内置过社区 OAuth 插件（Anthropic 条款风险），现在只剩社区第三方插件形态。文档同时点名 ChatGPT Plus、GitHub Copilot、GitLab Duo 是"零配置订阅"。GitHub Copilot 插件（`plugin/github-copilot/copilot.ts`）用 `Ov23li8tweQw6odWQebz` client 做 device flow（浏览器打开 `github.com/login/device`），自定义 fetch 注入 `x-initiator: agent|user`、`Copilot-Vision-Request`、`Openai-Intent: conversation-edits`，并从 Copilot API 拉活模型表过滤 picker。

### 1.3 Model 路由：`opencode.json` schema + agent/command 级覆盖 + variant

- 顶层 `model`（`"provider/model"` 字符串）、`small_model`（轻量任务专用：标题生成等；未设时取 provider 内"便宜模型"否则回落主模型；family 优先级 `["gemini-flash","gpt-nano","claude-haiku"]`，provider.ts:2048；插件可用 `experimental.provider.small_model` hook 改写，plugin index.ts Hooks）。Config 分层合并：remote `.well-known` → global `~/.config/opencode/opencode.json` → `OPENCODE_CONFIG` → project `opencode.json` → `.opencode` 目录 → `OPENCODE_CONFIG_CONTENT` → managed（docs/config precedence）。
- `agent.<name>`：`{description, mode: "primary"|"subagent"|"all", model, prompt, tools, permission, options, temperature, topP, variant}`（`agent/agent.ts:38-51` schema；docs/config Agents 节）。`default_agent` 必须是 primary（agent.ts:330-331）；`subagent_depth` 控制嵌套（默认 1，docs/config）。
- `command.<name>.model`：自定义 slash command 可钉模型（docs/config Commands 节示例 `anthropic/claude-haiku-4-5`）。
- **variant**：`model` 字符串支持 `provider/model#variant`（`config/v2-compat.ts:60,354-359`）。variants 由 `ProviderTransform.variants(model)` 按 family/npm-adapter 生成（`provider/transform.ts:777` 起的分派）：OpenAI 系 → `reasoning.effort`/`reasoningEffort`（none…xhigh，按 release_date 门控 none/xhigh，日期常量 :583-589）、Kimi/Anthropic-compat → `thinking:{type:"adaptive"}+effort`（:785-825，含 MiniMax/GLM-5.2 特例）、Google → `thinkingConfig.thinkingBudget|thinkingLevel`（:760-775）、xAI/OpenRouter/AI Gateway 各按 npm 分派（:843-875）。即"effort 档位"被统一成 model 上的命名 variant。
- `disabled_providers` / `enabled_providers`：全局开关（provider.ts:1445-1446）。运行期模型选择链：`input.model ?? agent.model ?? currentModel(session)`（`session/prompt.ts:469,646`），session 级模型可持久化进 session 记录（:614-685）。
- **"task-based routing" 的真相**：opencode 没有规则引擎式的 task→model 路由表；它用 (a) per-agent model 覆盖 + (b) `small_model` 槽位 + (c) `#variant` effort + (d) 命令级 model 四件套表达，路由决策由 agent 定义而非集中配置。

### 1.4 Agent loop：自研循环，AI SDK 只是一次 provider turn

`session/llm.ts` 的 `LLM.stream` 服务把"一次 provider 调用"抽象成 `Stream<LLMEvent>`：

- 默认路径：`ai` 包的 `streamText`（llm.ts:280-353）——`model` 是 `provider.getLanguage()` 给的 `LanguageModelV3`（llm.ts:97；getLanguage→resolveSDK，provider.ts:1896+），外面包一层 `wrapLanguageModel` middleware 在 `transformParams` 里跑 `ProviderTransform.message()` 做 per-provider 消息归一（llm.ts:325-333）；`experimental_repairToolCall` 修坏 tool call（:296）；`providerOptions` 由 `ProviderTransform.providerOptions` 映射（:316）；`tools`/`activeTools`/`toolChoice`/`maxRetries`/`abortSignal`/`headers` 全走 AI SDK 原生参数。
- 备选路径：`LLMNativeRuntime`（`@opencode-ai/llm` 自研传输，`flags.experimentalNativeLlm` 才启用，llm.ts:226-269）——同一 `LLMEvent` 流接口，不支持则带 reason 回落 ai-sdk。
- AI SDK `fullStream` 经 `LLMAISDK.toLLMEvents` 归一成内部事件（llm.ts:372-378）。

**多轮循环在 SDK 外**：`SessionProcessor.process`（session/processor.ts:640+）跑 `llm.stream` 一次、把事件喂给 `handleEvent`（tool_call → 执行 → tool_result part），返回 `"compact"|"stop"|"continue"`；`session/prompt.ts:1088` 的 `while(true)` 据此继续下一轮、触发 `compaction.create`（overflow 检测 :1164）或 `handleSubtask`（Task 工具 → 子代理 :1145）。即：**AI SDK 管"一次 turn 的流式 + 工具 schema"，opencode 自己管"turn 之间的循环、压缩、子代理、重试"**（`SessionRetry.policy` 按 provider 定制，processor.ts:674-680）。

请求整形集中在 `session/llm/request.ts` 的 `LLMRequestPrep.prepare`（:56-160）：system prompt 分层（agent.prompt → `SystemPrompt.provider(model)` per-provider prompt 文件：`session/prompt/{codex,anthropic,gpt,gemini,kimi,...}.txt`）、`experimental.chat.system.transform` hook、options 按 provider→model→agent→variant 深合（:78-90）、`chat.params`/`chat.headers` 插件触发点（:110-145）、Responses 系 provider 的工具强制 `strict:false`（:~150）。

### 1.5 Plugin 系统：Hooks 对象模型

插件 = JS/TS module，导出 `Plugin = (input: PluginInput, options?) => Promise<Hooks>`（`packages/plugin/src/index.ts`）。`PluginInput` 给 `client`（opencode SDK client，连本进程内嵌 server）、`$`（Bun shell）、`project/directory/worktree/serverUrl`、`experimental_workspace.register`（plugin/index.ts:147-165）。

`Hooks` 可挂的点（packages/plugin/src/index.ts，完整接口）：`event`（总线）、`config`（改配置）、`tool`（注册自定义工具）、`auth`（provider 的 auth 方法+loader）、`provider`（改 model 表）、`chat.message`、`chat.params`（temperature/topP/topK/maxOutputTokens/options）、`chat.headers`、`permission.ask`、`command.execute.before`、`tool.execute.before/after`、`shell.env`、`tool.definition`、`experimental.chat.{messages,system}.transform`、`experimental.provider.small_model`、`experimental.session.compacting`、`experimental.compaction.autocontinue`、`experimental.text.complete`。

加载：`.opencode/plugins/`（项目）+ `~/.config/opencode/plugins/`（全局）自动扫描；`plugin: ["pkg", ["pkg", opts]]` config 声明 npm 包，启动时 Bun 安装到 `~/.cache/opencode/node_modules/`（docs/plugins；`plugin/index.ts:181-187` 的 `plugin_origins`→`PluginLoader.loadExternal` + `plugin/install.ts`）。**Provider 可经插件接入，但只能挂到 catalog 已有的 provider id 上**（`ProviderHook.id` + `AuthHook.provider` 都是对既有 id 的改写/凭据供给；新增 id 走 config `provider` 块）——内置 CodexAuthPlugin 就是挂到 `"openai"` 这个 catalog id（codex.ts:289,329）。

---

## 2. Hermes Agent（NousResearch/hermes-agent）

### 2.1 消歧

检索命中三类"hermes agent"：**(a) `NousResearch/hermes-agent`**——Nous Research 出品的个人 AI agent（Python 主代码 + Node/Electron 桌面/TUI），2025-07-22 建库、246k stars、MIT，README 定位"self-improving AI agent … creates skills from experience"。**(b) `Ouroborosrex/hermes-claude-code-cli-provider`**——一个第三方 hermes model-provider 插件（把 Claude Code CLI 包成 OpenAI-compatible shim），佐证 (a) 的插件生态真实存在。**(c) NousResearch Hermes-4 模型**——纯模型，无 provider 生态。结论："hermes agent" = (a)。**它≠OpenClaw**：README 有 `hermes claw migrate` 专章（"Migrate from OpenClaw … detects `~/.openclaw`"，README.md:115,191-213），是两个独立项目；以下 `providers/`、`hermes_cli/`、`agent/`、`plugins/`、`cli-config.yaml.example` 路径均指 hermes-agent @ main（2026-09-17 clone）。

### 2.2 Provider 架构：声明式 ProviderProfile + 懒发现注册表

`providers/base.py` 的 `ProviderProfile` dataclass（:39-140+）把一个 provider 的全部事实装进一个对象：

| 字段组 | 字段 |
|---|---|
| 身份 | `name`、`aliases`、`api_mode`（默认 `"chat_completions"`）、`display_name`/`description`/`signup_url` |
| Auth/端点 | `env_vars`、`base_url`、`models_url`、`auth_type`（profile 层取值 `api_key`\|`oauth_device_code`\|`oauth_external`\|`copilot`\|`aws_sdk`\|`external_process`；CLI catalog 层另有 `oauth_minimax`，`hermes_cli/provider_catalog.py:23`、`auth.py:150,204`）、`supports_health_check`、`supports_model_listing` |
| 能力开关 | `supports_vision`、`supports_vision_tool_messages`（如 Xiaomi 拒 list 型 tool 内容）、`supports_prompt_cache_key` |
| 外部进程 provider | `process_command`/`process_args`/`process_command_env_vars`/`process_args_env_var`（`auth_type="external_process"`，ACP 驱动 agent CLI） |
| 目录/路由 | `fallback_models`（picker 兜底）、`hostname`、`default_aux_model`（侧任务便宜模型） |
| quirk | `default_headers`、`fixed_temperature`（含 `OMIT_TEMPERATURE` 哨兵）、`default_max_tokens` |
| hooks | `fetch_models`（Anthropic 覆写为 x-api-key + cursor 分页，`plugins/model-providers/anthropic/__init__.py:17`）、`prepare_messages`（Qwen 归一 content + 给 system 末块打 `cache_control`，`plugins/model-providers/qwen-oauth/__init__.py:29`）、`build_extra_body`、`build_api_kwargs_extras`（Copilot 的 reasoning effort clamp）、`resolve_aux_model` |

**注册表**（`providers/__init__.py`）：`register_provider(profile)` 写 `_REGISTRY`/`_ALIASES`，last-writer-wins（:56-66）。懒发现 `_discover_providers()` 在首次 `get_provider_profile()/list_providers()` 时扫三处：**bundled `plugins/model-providers/<name>/`**（`__init__.py` import 时自注册 + `plugin.yaml` manifest）、**`$HERMES_HOME/plugins/model-providers/`**（用户覆盖同名）、**pip `hermes_agent.plugins` entry points**；另有 legacy `providers/<name>.py` 单文件发现（文件头 docstring:1-34）。bundled 约 40 个：`anthropic`、`openai-codex`、`copilot`、`copilot-acp`、`qwen-oauth`、`minimax`、`xai`、`xiaomi`、`zai`、`kimi-coding`、`nous`、`openrouter`、`azure-foundry`、`bedrock`、`vertex`、`custom`、两个 OpenCode 网关（`opencode-zen`/`opencode-go`/`opencode-free`）等（`plugins/model-providers/` 目录；`hermes_cli/auth.py:160-278` 的 `ProviderConfig`/`PROVIDER_REGISTRY`——CLI 层的第二套注册表，含 auth_type 与 key_env 优先级）。

### 2.3 订阅 auth：auth.json + 凭证池 + 三种获取形态

**存储**：`~/.hermes/auth.json`——`providers.<id>.tokens`（singleton {access_token, refresh_token, last_refresh}）+ `credential_pool.<provider>`（多账号条目：source `device_code` / `manual:device_code` / `manual:api_key`，带 label/冷却状态；`hermes_cli/auth.py:466-836` + `auth_codex.py:84-160`）。profile 机制下每个 named profile 只读自己的 auth.json，不继承 root（auth.py:671-769）。Codex refresh token 是**单次轮换**，池条目按"旧 access_token 匹配"判断是否 singleton 别名决定是否同步轮换（auth_codex.py:104-144）。

**CLI**：`hermes auth` / `hermes auth add <provider> --type oauth`（`hermes_cli/auth_commands.py:27` `_OAUTH_CAPABLE_PROVIDERS = {anthropic, nous, openai-codex, xai-oauth, qwen-oauth, minimax-oauth, openrouter}`，:214-260 的 per-provider `_OAuthAddSpec`）。

**ChatGPT/Codex**：`_codex_device_code_login` device-code 流（`hermes_cli/auth_commands.py:235-236` → `hermes_cli/auth_codex.py:677`，login 时自动尝试导入既有 Codex CLI 凭证 :692）；**可导入 Codex CLI 自己的凭证**：`_import_codex_cli_tokens()` 读 `$CODEX_HOME`（默认 `~/.codex`）`auth.json` 的 `tokens.{access_token,refresh_token}`，过期则跳过（`auth_codex.py:405-423`）。运行态 `resolve_codex_runtime_credentials` 单飞刷新 + 池回落 + 配额探针缓存（auth_codex.py:427）。Provider 侧：`openai-codex` profile 是 `api_mode="codex_responses"`、`base_url="https://chatgpt.com/backend-api/codex"`、`auth_type="oauth_external"`（`plugins/model-providers/openai-codex/__init__.py:5-11`）。

**Claude 订阅（本项目最关心）**：三条路（`agent/anthropic_credentials.py`）——
1. env：`ANTHROPIC_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN`（`auth.py:210` 注释明确 `sk-ant-oat01…` 不是 API key；"401s as x-api-key, 429s as bare Bearer"，adapter 按前缀判别走 OAuth 道）；
2. **借 Claude Code 的凭证**：`read_claude_code_credentials` 依次读 macOS Keychain（`security find-generic-password -s "Claude Code-credentials"`，:204-226）与 `~/.claude/.credentials.json` 的 `claudeAiOauth{accessToken,refreshToken,expiresAt}`（:227-249），且 `_prefer_refreshable_claude_code_token` 让"可刷新的 Claude Code token"优先于静态 env token（:403-413）；
3. **自带 PKCE**（:502-575）：`run_hermes_oauth_login_pure`（:516）用 Claude Code 同一 public client `9d1c250a-e61b-44d9-88ed-5944d1962f5e`（:34，注释"mirrors Claude Code / pi-ai / OpenCode"）→ `https://claude.ai/oauth/authorize`（S256+state）→ 浏览器跳 `console.anthropic.com/oauth/code/callback` 显示 `code#state`、用户**手动粘贴回来**（无本地回调 server）→ `POST platform.claude.com/v1/oauth/token`（fallback `console.anthropic.com/v1/oauth/token`，:35-37）→ 存 `~/.hermes/.anthropic_oauth.json`（:505-506），`refresh_anthropic_oauth_pure` 轮换（:288）。
**发送端**（`agent/anthropic_adapter.py`）：`_auth_style` 按 base_url/token 前缀分流——第三方 Bearer 端点（MiniMax、Azure Foundry）走 `bearer`，`sk-ant-oat*` 走 `oauth`（:364-400）；oauth 道置 `auth_token` + **`user-agent: claude-code/<ver> (external, cli)` + `x-app: cli`**（:405-406，注释"Anthropic routes OAuth by user-agent; without it, 500s"，版本号读本地安装的 claude 防过期 :216-224）+ OAuth-only betas `claude-code-20250219, oauth-2025-04-20`（:213）+ **工具名 `mcp__` 前缀化**（`_oauth_wire_namer`，:449——注释 :439-441 说明 OAuth billing 拒裸工具名、HTTP 400 "Third-party apps now draw from extra usage"；响应侧 `agent/transports/anthropic.py:12` `_unprefix_oauth_tool_name` 反解）。

**其他订阅**：`minimax-oauth`（PKCE；profile 层 `auth_type="oauth_external"`、CLI catalog 层 `auth_type="oauth_minimax"`，`auth.py:204` + `plugins/model-providers/minimax/__init__.py:50-61`，注意 `api_mode="anthropic_messages"`、`base_url=api.minimax.io/anthropic`——MiniMax 订阅走 Anthropic 协议）、`qwen-oauth`（oauth_external，portal.qwen.ai，`plugins/model-providers/qwen-oauth/__init__.py:69`）、`xai-oauth`（device code）、`nous`（oauth_device_code + shared-credential import，`plugins/model-providers/nous/__init__.py:73`）、`copilot`（`auth_type="copilot"`，`COPILOT_GITHUB_TOKEN`/`GH_TOKEN`）、`openrouter` OAuth、`spotify`。第三方插件已实证生态：`tmdgusya/hermes-provider-switcher`（把 GLM/Kimi/MiniMax 的 `ANTHROPIC_BASE_URL` 凭据喂给 Claude Code 子进程）、`Ouroborosrex/hermes-claude-code-cli-provider`。

### 2.4 传输分派：`api_mode` + ProviderTransport 注册表

内部消息始终是 OpenAI chat 格式；`api_mode` 决定 wire 形状。`_VALID_API_MODES = {chat_completions, codex_responses, anthropic_messages, bedrock_converse, codex_app_server}`（`hermes_cli/runtime_provider.py:97`）。解析序：显式 `api_mode` config → `_HOST_MANDATED_API_MODES` 主机名直查（`api.anthropic.com→anthropic_messages`、`api.x.ai`/`api.meta.ai`/`api.router.com→codex_responses`，:90-92，:118 还有 `is_official_openai_host→codex_responses` 兜底）→ `providers.determine_api_mode(provider, base_url, model)`（含 per-model 分派，如 OpenCode Go 按模型分流 OpenAI/Anthropic 协议，`auth.py:230-231` 注释）→ 默认 `chat_completions`（:139-156）。`agent/transports/` 注册表（`__init__.py:21` `register_transport`）：`{anthropic, codex, chat_completions, bedrock}` 模块自注册，`ProviderTransport` ABC 声明 `convert_messages/convert_tools/build_kwargs/normalize_response/validate_response/extract_cache_stats/map_finish_reason`（`base.py:12-40+`）——OpenAI 内部模型 ↔ 各 wire 协议的双向适配全在这里。

### 2.5 Model 路由：fallback 链 + auxiliary 按任务覆盖 + moa 虚拟 provider

`config.yaml` `model:` 节（`cli-config.yaml.example:43-90`）：`default`（`"anthropic/claude-opus-4.6"` 形式）、`provider`、`base_url`、`api_key`/`key_env`/`key_cmd`（命令取 token！`agent/auxiliary_client.py` `_named_custom_api_key`）、`api_mode`、`auth_mode`（Azure `entra_id`）、`streaming`、`context_length`。运行时切换 `hermes model` / `/model`（`hermes_cli/model_switch.py`，CLI+gateway 共用一条 pipeline）。

- **fallback 链**：`fallback_model`/`fallback_providers` 单 dict 或 list，`_fallback_entries` 归一后按序降级（`agent/agent_init.py:1026-1029` + `auth.py:820-843` 的 `_routed_client_kwargs`；配额/限流语境下与 credential_pool 条目冷却联动）。
- **auxiliary 侧任务路由**（`auxiliary:` 节，cli-config.yaml.example:830-890+）：每个 side-LLM 任务（`vision`、`web_extract`、`tts_audio_tags`、`title_generation`、`session_search`、`compression`、`curator`、`background_review`、`moa_reference`）可独立钉 `provider/model/timeout/reasoning_effort(none|minimal|low|medium|high|xhigh|max|ultra)/extra_body/max_concurrency`。`agent/auxiliary_client.py::_resolve_auto_route`（:4373-4397）的优先级：显式任务覆盖 → 主 provider+主模型（"auto"）→ 任务级 fallback 链 → 主 fallback 链 → discovery 链（OpenRouter→Nous→custom→Codex→API-key providers）。`default_aux_model` 在 profile 层给默认值（如 anthropic 的 `claude-haiku-4-5`）。
- **`moa` 虚拟 provider**：`provider: moa` 走 `agent/moa_loop.py` 的 Mixture-of-Agents——配置多个 reference slot + 一个 aggregator slot（各自独立 provider/model），`provider=="moa"` 在 slot 里递归禁（`hermes_cli/moa_config.py:140-143`）。
- `smart_model_routing.enabled`：setup wizard 写入的开关（`hermes_cli/setup_quick.py:202`），默认关。

### 2.6 Agent loop 与插件系统

**Loop**：`agent/conversation_loop.py::run_conversation`（`agent/AGENTS.md` 描述）——同步 while，`client.chat.completions.create(model, messages, tools)` per iteration（对非 OpenAI wire 先经 transport 转换），tool_calls → `handle_function_call` → append → 继续；`max_iterations` 默认 500。两个硬不变量：per-conversation prompt 缓存不可破坏（system prompt 生命周期内 byte-stable，压缩是唯一允许的断点）+ 严格 role 交替。**即：内部规范化为 OpenAI 格式、provider 差异完全压进 profile+transport 两层**，与 opencode"AI SDK LanguageModel + 自研 loop"是同构选择。

**插件**（`plugins/AGENTS.md`）：`PluginManager` 发现 general 插件（`plugins/<name>/`、`~/.hermes/plugins/`、`./.hermes/plugins/`、pip entry points，later-wins），`register(ctx)` 可挂 `pre_tool_call/post_tool_call/pre_llm_call/post_llm_call/on_session_start/on_session_end` hooks、`ctx.register_tool`、`ctx.register_cli_command`。专门 kind：memory provider（`plugins/memory/`）、**model provider**（§2.2）、context engine、image-gen、platform adapters。外发插件经 `plugin-catalog/`（YAML + 40-hex SHA pin + `hermes plugins validate` CI + `removed.yaml` kill list）。原则："plugins never touch core"——要能力就拓宽通用 hook 面，不许插件改 core 文件。

### 2.7 厂商 CLI 当 provider（与本项目同构的形态）

- `codex_app_server` api_mode：`agent/transports/codex_app_server.py`——spawn `codex` CLI 的 app-server，stdio 上跑换行 JSON-RPC 2.0：`initialize` → `thread/start` → `turn/start`，流式收 `item/*` 通知到 `turn/completed`（文件头 docstring；MIN_CODEX_VERSION=(0,125,0)）。即 OpenAI 订阅不经 HTTP API、而是经 vendor CLI 的 harness 复用其 auth+工具核——**与 Claude Agent SDK 在本项目的角色完全同构**。
- `auth_type="external_process"`（ProviderProfile，base.py:83-92）+ `copilot-acp` 插件：`process_command="copilot"`、`process_args=("--acp","--stdio")`、env 覆盖可换二进制（`plugins/model-providers/copilot-acp/__init__.py:34-55`）——Agent Client Protocol 驱动外部 agent CLI。

---

## 3. 周边参考（只录增量机制）

### 3.1 OpenClaw（`openclaw/openclaw`）

**与 Hermes 是不同项目**（§2.1）。机制：provider = `extensions/<name>/` 一级扩展包（含 `openclaw.plugin.json` manifest），~168 个扩展（anthropic、openai、codex、copilot、copilot-proxy、xiaomi、zai、qwen、tencent、amazon-bedrock{,-mantle}、anthropic-vertex、openrouter、vercel-ai-gateway、vllm、sglang、以及 telegram/slack/whatsapp/browser 等非 LLM 扩展）。**增量**：把"厂商 CLI 即 provider"做成正式扩展形态——`extensions/anthropic/` 的 `cli-auth-seam.ts` 直接跑 `claude auth status --json` 探测 CLI 登录态（不读 token 材料）、`cli-backend.ts`/`cli-process.ts` 驱动 CLI；`extensions/codex/` 有 `harness.ts` + `provider-discovery.ts`。即订阅 auth 完全委托给 vendor CLI 自己的凭证库，连 token 都不落自家存储。

### 3.2 goose（`block/goose`，Rust）

`crates/goose/src/providers/`：`Provider` trait + `ProviderDef`/`ProviderMetadata` + `provider_registry.rs` 的 `ProviderEntry{metadata, constructor, inventory_*}` 注册表（provider_registry.rs:15-60+）。**增量**：(a) `chatgpt_codex.rs` 与 opencode 逐字同款的 ChatGPT OAuth（同 `CLIENT_ID`/`ISSUER`/`:1455`/backend-api endpoint，`jsonwebtoken` 验 id_token）；(b) CLI-subprocess provider 族：`claude_code.rs`、`codex.rs`、`gemini_cli.rs`、`cursor_agent.rs`，加上 ACP 族 `claude_acp.rs`/`codex_acp.rs`/`copilot_acp.rs`/`amp_acp.rs`/`pi_acp.rs`——把别家 agent CLI 当 provider 是 goose 的一等公民；(c) `gemini_oauth.rs`/`xai_oauth.rs`/`oauth_device_flow.rs`/`command_auth.rs`（命令产 token）；(d) `litellm.rs`——直接以 LiteLLM proxy 为 provider 适配；(e) `toolshim.rs`——给 tool-calling 弱的模型套 XML 工具协议 shim。

### 3.3 Cline / Roo Code

- **Cline** 已重构为 `sdk/packages/llms` 包（`cline/cline` 树）：同样收敛到 **Vercel AI SDK + models.dev**——`src/providers/ai-sdk.ts` + `scripts/models/generate-models-dev.ts` 生成 `catalog.generated.ts` + `providers/vendors/{anthropic,bedrock,cline,community,google,minimax-thinking,mistral,ollama,openai,openai-compatible,vertex}.ts` + `tests/provider-vcr/` 录制回放契约测试。webview 侧 `ClaudeCodeProvider.tsx` 表明 claude CLI 作为 provider 仍在。**增量**：把 provider 层抽成可发布的独立 SDK 包 + VCR 式 provider 契约测试。
- **Roo Code**（`RooCodeInc/Roo-Code`）：`src/api/providers/*.ts` 一 provider 一 `ApiHandler` 类（33 个文件）。**增量 = API Configuration Profiles**（docs.roocode.com/features/api-configuration-profiles）：命名的 {provider+key+model+temperature+thinking budget+rate limit} 预设，**可按 mode 绑定**（code/architect/ask/debug + 自定义 mode 各自钉不同 profile，系统记忆每 mode 上次所用），per-task sticky——子任务继承父任务 profile，重开历史任务还原当时 profile；key 存 VSCode Secret Storage。这是"按任务类型路由"的最直白产品化。

### 3.4 Aider

litellm 作唯一 provider 层（aider.chat/docs/llms/other.html："Aider uses the litellm package"），env var 一 provider 一个。**增量 = 角色化 model 槽位**（aider.chat/docs/config/options.html）：`--model`（主）/`--weak-model`（提交信息、历史摘要等轻活）/`--editor-model` + `--editor-edit-format`（architect/editor 分工模式：主模型产出方案、editor 模型落地 diff）/`--architect`；`--model-settings-file`/`--model-metadata-file`/`--alias ALIAS:MODEL`；`--api-key PROVIDER=KEY` 按 provider 给 key。无订阅 OAuth（litellm 之外只有 GitHub Copilot 一节的 token 说明）。

---

## 4. 对比矩阵

| 维度 | opencode | Hermes Agent | OpenClaw | goose | Cline/Roo | Aider |
|---|---|---|---|---|---|---|
| Provider 抽象 | models.dev catalog（数据）+ `npm` 字段选 AI SDK 包 + config/plugin 覆盖 | `ProviderProfile` dataclass + `api_mode` + `ProviderTransport` 注册表 | `extensions/<name>/` 插件包 | Rust `Provider` trait + registry | AI SDK + models.dev 生成目录 / `ApiHandler` 类 | litellm 单入口 |
| 自定义 OpenAI 兼容端点 | `provider.<id>.npm:"@ai-sdk/openai-compatible"` | `provider: custom` + `base_url`（+`api_mode` 可选） | extension 包 | `openai_compatible` provider | `openai-compatible` vendor/handler | `openai/` 前缀 + `OPENAI_API_BASE` |
| ChatGPT 订阅 OAuth | 内置插件（PKCE+device，codex.ts） | 内置 device-code + `~/.codex` 导入 | `extensions/codex`（CLI harness） | `chatgpt_codex.rs`（PKCE） | Cline 有 openai-codex handler（API key 流为主） | 无 |
| Claude 订阅 OAuth | **1.3.0 起官方移除**（条款禁止） | 三形态：env token / 借 Claude Code credentials·Keychain / 自带 PKCE | `extensions/anthropic` 复用 `claude` CLI 登录 | `claude_code.rs`/`claude_acp.rs`（CLI/ACP） | `ClaudeCodeProvider`（CLI） | 无 |
| 其他订阅 | Copilot/GitLab Duo/Poe/xAI/DigitalOcean/Snowflake | minimax(PKCE)/qwen/xai/nous/copilot/openrouter | copilot 系扩展 | gemini/xai oauth + copilot_acp | vscode-lm（VS Code 提供的模型） | GitHub Copilot |
| 凭证存储 | `~/.local/share/opencode/auth.json`（oauth/api/wellknown union） | `~/.hermes/auth.json` + credential_pool 多账号 + per-profile 隔离 | vendor CLI 凭证库（不落自家） | keyring/config | VSCode Secret Storage | env/`--api-key` |
| 任务级路由 | per-agent model + small_model + `#variant` effort + command model | `auxiliary:` per-task override + fallback 链 + `default_aux_model` + `moa` 聚合 | —（按 session） | `GOOSE_MODEL`/lead 系配置 | **Roo: per-mode profile 绑定 + sticky** | **角色槽位：main/weak/editor** |
| Agent loop | 自研 while + AI SDK `streamText` per turn（native runtime 可选） | 同步 while + transport 双向转换（OpenAI 内部格式） | vendor CLI harness | 自研（Rust agent） | VS Code 扩展内自研 | 自研 + litellm |
| 插件能加 provider? | 半（auth/provider hook 只能改既有 catalog id；新 id 走 config） | 能（model-provider plugin 自注册，含 OAuth/auth_type） | 能（provider 本身就是扩展） | 编译期 registry | 否（改代码） | 否 |

---

## 5. 对本项目的启示

### 5.1 先盘清"离开 Agent SDK 会失去什么"

`src/server/ai/runner.ts` 目前从 SDK 拿走的能力（全部有生产调用方）：

- **tool-use loop**：`mcpServers`（in-process MCP，`tools/mcp-bridge.ts` 把 Domain Tool Registry 包成 SDK MCP server）+ `allowedTools` + `maxTurns`（runner.ts:184-189,585-587）。替换 = 自研 turn 循环 + tool schema 序列化 + tool_result 回填。
- **PreToolUse 门 + canUseTool 权限回调**：`spawn-contract.ts` 的 v2 子代理契约（kill switch、unknown-agent 拒绝、model/isolation/background 输入覆写拒绝、前台强制、按 toolUseID 记忆化双闸一致性），被 `capabilities/agency/server/meeting/director.ts:412-413` 消费。替换 = 在自研 loop 的 tool dispatch 前重建等价闸门。
- **SDK 子代理**：`Options.agents` + Task/Agent 工具 + `task_started/progress/updated/notification` 事件（runner.ts:229,109-115,344-355）。替换 = 自研 subagent spawn + 生命周期事件合成。
- **nativeCompaction**：Copilot live-session 的 SDK 原生压缩 + `sessionContext` 重注入（runner.ts:233-236,646-660）。替换 = 自研压缩（hermes 的 ContextCompressor 是参照）。
- **session persist/resume**：`sdkSession.persist/resume/onSessionId`（runner.ts:301-305,691-703）。替换 = 自存消息历史 + provider 侧 resume 语义（各家不一，Anthropic 无服务端 resume——只能回放）。
- **skills 装载**：isolated `CLAUDE_CONFIG_DIR` + `Options.skills` 白名单（runner.ts:193-212,451-458,556-560）。替换 = skill 内容注入 prompt 或自研装载。
- **`outputFormat` 结构化输出**（runner.ts:221,587）、**`settingSources` 隔离**（:600-610）、**`effort`/thinking blocks**（AGENTS.md §关键约束；adaptive thinking 元数据）、**`SDKMemoryRecallMessage`**（:8）、**`maxBudgetUsd`**（anthropic metered lane）、**`permissionMode: 'bypassPermissions'`**（:588）、**env 全替换**（key/oauth 双 lane，providers.ts + buildAgentEnv）。
- **进程隔离红利**：SDK 子进程天然隔离 CLI 的全局副作用；自研 in-process loop 要自行保证不读 repo `CLAUDE.md`/hooks（AGENTS.md 已为此设 `settingSources:[]` 纪律）。

### 5.2 结论先行：协议面决定方案，而不是 auth 面

盘点外部实现后，**"订阅 auth"本身并不需要换掉 Agent SDK**——`anthropic-sub` lane 已经在用 OAuth；连 ChatGPT Codex OAuth 的实现（opencode `codex.ts`、goose `chatgpt_codex.rs`、hermes `auth_codex.py`）也只是一个 ~500 行的 PKCE+refresh+自定义 fetch 模块。**真正挡在 SDK 前面的是 wire 协议**：Agent SDK 只会讲 Anthropic Messages（经 `ANTHROPIC_BASE_URL` 指向兼容端点）。要接 ChatGPT Codex（`codex_responses`）、原生 OpenAI chat、Bedrock Converse、Google，必须有一条非 SDK 执行道——问题由此从"换不换 SDK"变成"**给非 Anthropic 协议 provider 开一条并行 lane，还是把 agentic 核整体换引擎**"。

### 5.3 方案（按风险/工作量排序）

**方案 A（最低风险）：保留 Agent SDK 作 agentic 核；沿 `executeDirectProviderAttempt` 现有 seam 扩"直连 lane"**

项目已有非 SDK 直连道：`direct-provider-attempt.ts` 的 `executeDirectProviderAttempt`（durable attempt 生命周期 + usage/cost 落账）已被 `embed.ts`、`memory/reconcile-llm.ts`（GLM `/chat/completions` 直连）、`ingestion/provider-attempts.ts` 使用。把这条 seam 从"调用方自带 fetch"升级为"provider registry 驱动的 chat 抽象"：

- 在 `providers.ts` 给 `ProviderConfig` 加 `apiMode: 'anthropic-messages' | 'openai-chat' | 'openai-responses'` 判别字段（hermes 的 api_mode 概念，`runtime_provider.py:97`），`ResolvedProvider` 携带协议；
- runner 侧按 `resolved.apiMode` 分流：Anthropic 协议照旧走 SDK `query()`；非 Anthropic 协议走新的 direct-chat lane（`@anthropic-ai/sdk` 已在依赖里，OpenAI 协议用 fetch 或 `@ai-sdk/openai-compatible`）；
- 适用边界：只允许 `needsToolCall=false` 的一次性 task（judge/extract/summarize 占大头）走直连 lane；tool-use/subagent/copilot 任务仍走 SDK。**这把 80% 的"想换 provider"诉求（换模型跑便宜任务）在不动执行核的前提下解决**。
- Auth 增补：ChatGPT Codex lane 按 opencode 形态实现——`auth.json`-equivalent 的 token 文件（或继续 env-only：`CHATGPT_OAUTH_ACCESS`/`_REFRESH`），自定义 fetch 改写 `chatgpt.com/backend-api/codex/responses` + `ChatGPT-Account-Id` 头（codex.ts:348-437 的全部业务逻辑）；Claude 订阅维持现状。
- 失去：直连 lane 无 tool loop/结构化 outputFormat/持久 session——恰好都是一次性任务用不到的东西。保留：全部现有执行核。

**方案 B（中等）：自研轻量 tool loop + provider registry（opencode 式），SDK 退居 copilot/subagent lane**

把 runner 拆成两层：`runTask`（一次性/少轮工具任务）走自研 loop（AI SDK `streamText` + `activeTools` + 手工 tool dispatch——opencode `session/llm.ts` + `processor.ts` 的范型，~1.5k 行核心）；`runAgentTask`/copilot/spawn-contract 仍走 SDK。

- Provider 层照搬 opencode 三分法：`model-catalog.snapshot.json`（项目已有，YUK-924）+ `PROVIDERS` 声明 `npm`/适配器 + env/auth 覆盖。registry 的 `defaultProvider/defaultModel` 已就位；按 task 粒度分派天然匹配现有 `resolveTaskProvider`。
- Auth：照 opencode `auth.loader` 模式——每个 OAuth provider 一个 {获取/刷新/注入 fetch} 模块；Claude 订阅若要脱离 `claude` CLI 依赖，照 hermes 三形态（env token / 读 `~/.claude/.credentials.json` / 自带 PKCE，`anthropic_credentials.py:204-249,403-413,502-575`），并补 `user-agent: claude-code/<ver>` + `x-app: cli` + `mcp__` 工具前缀 + OAuth-only betas 的兼容性变换（`anthropic_adapter.py:405-406,449,213`）。
- 失去：SDK 的 thinking-block 语义、Task 生命周期事件、hooks 事件面——需要在自研 loop 里重实现（run-lifecycle/sdk-terminal 的适配层已经隔离了大部分消息形状，工作量集中在流归一 + tool 协议）。
- 风险：mimo/zhipu 的 Anthropic-compat 在自研 Anthropic 适配下行为差异要重验证（thinking 归一、`structuredOutput:false` 约束已在 PROVIDER_MODEL_BINDINGS 里，可保留）。

**方案 C（最彻底）：整体换掉 SDK——opencode/Hermes 式 catalog+transport+自研 loop**

执行核全自研：while loop + tool dispatch + 压缩 + 子代理（hermes `conversation_loop.py` + `agent/transports/*` 范型；或 opencode `llm.stream` + processor + prompt 三层）。除方案 B 的失去项外，再失去：spawn-contract 双闸（需在 tool dispatch 前重建等价物，好在 `spawn-contract.ts` 的判定逻辑本身可平移——它只依赖 toolUseID/toolName/input 三元组）、nativeCompaction（自研压缩提示词 + `sessionContext` 重注入）、SDK session resume（copilot chat 持久化要改为本地消息回放）、skills 装载（改为 prompt 注入或保留文件装载语义）。

- 收益：provider 面完全打开（codex_responses/anthropic_messages/chat_completions/bedrock_converse/外部 CLI harness 都能挂）、无子进程开销、无 SDK 版本锁（YUK-365 Finding 3 的 Dockerfile sdkdeps 约束消失）、凭证池/多账号（hermes credential_pool）可直接搬。
- 成本：`runner.ts`（~1400 行）+ `sdk-terminal.ts` + `run-lifecycle` SDK 耦合面 + `populate-skills` + spawn-contract 适配层 + copilot session 持久化 + 全部 stream/observer seam 的重写与真实 provider 回归。这是数周级工作，且执行核是 release-critical。

**方案 D（正交增量）：多账号凭证池 + 任务级 aux 路由（不换引擎也能拿）**

无论选 A/B/C，hermes 的两个路由机制都值得直接抄到现有 registry：(a) `fallback_model`/`fallback_providers` 有序降级链（`agent_init.py:1026` + `auth.py:820-843`——比现有 `crossoverModelForProvider` 单跳更一般化，且与凭证池冷却联动）；(b) `auxiliary:` 式 per-task provider/model 覆盖（项目已有 `override` 参数，缺的是 config 级声明面——把 `AI_PROVIDER_OVERRIDE` 的"全局单开关"扩成"按 TaskKind 表"，即 Roo Code per-mode profile 的思路）。

### 5.4 建议

- **若动机主要是"用订阅额度跑更多任务"**：方案 A + D。新增 `apiMode` 判别 + 直连 chat lane（GLM reconcile 已是先例），ChatGPT Codex OAuth 按 codex.ts 形态实现为 token 文件 + 自定义 fetch；Claude Max lane 维持 SDK。工作量约集中在 `providers.ts` 判别字段 + 一个新 `direct-chat.ts` + OAuth 模块，runner 不动。
- **若动机是"摆脱 SDK 版本锁/子进程开销，且接受重写执行核"**：方案 B 起步（runTask 先走自研 loop），C 作为 copilot/spawn 的后续阶段。opencode 的 `llm.stream` 抽象（一次 provider turn = 一条 LLMEvent 流）是最贴合本项目 `runTask/runAgentTask/streamTask` 三入口的范型。
- **不要做的事**：照搬 opencode 的"插件系统"来解决 provider——插件化是客户端产品给用户扩展的形态；本项目 provider 变更频率低、且 AI 调用必须经 Hono/worker 留痕（AGENTS.md 边界），config 层（providers.ts + registry.ts）已足够。hermes 的 `ProviderProfile` 声明式字段（api_mode/env_vars/auth_type/fallback_models/quirk flags）比插件更贴合：它就是我们 `BoundProviderConfig` 的超集形态。

**置信度说明**：opencode 与 hermes 的全部主张来自 2026-09-17 当天 checkout 的源码实读（file:line）；OpenClaw/goose/Cline 的文件级主张来自 `gh api` 文件树与抽读文件；Roo/Aider 来自官方文档页。models.dev catalog 字段名以 `provider.ts:1265-1330` 转换函数为准。opencode dev 分支是最新开发态，个别字段（如 `api_mode` 集合、ALLOWED_MODELS 名单）随版本漂移，引用时已注明行号。
