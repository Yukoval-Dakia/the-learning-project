# 供题系统 · 学科网真题获取 + 治理架构（设计草案 + spike 实证 · 发现汇总）

> 日期：2026-07-13
> 状态：**设计草案（待 owner 定夺若干 fork）+ 一份真卷 spike 已实证 + 一处切块 bug 已修**
> 范围：从「参考实验室评估」到「学科网真题获取 + 治理」的完整调查弧与所有发现
> 权威前置：[2026-07-10 供题系统架构研究](./2026-07-10-question-supply-system-architecture-research.md) · [2026-07-10 subject-control-plane](./2026-07-10-subject-control-plane.md)

---

## 0. 调查弧（怎么走到这一步）

1. **评估参考实验室**：外部隔离仓 `codex/provider-neutral-adapter`（证据库存供题控制面 spike）→ 裁决 **port-selectively**（§1）。
2. **现行 vs 新建对照**：现行供题线**不是笨队列**，差别在「记忆与治理」不在「发现」（§2）。
3. **需不需要新供给线**：n=1 现状落在设计权威自己写的「Simplify」区间——**除非获取侧变了**（§3）。
4. **获取侧真变了**：owner 用**学科网付费会员**可 browser-download 真题试卷 → 真实内容供给路成立 → 之前判「过度」的治理机械（去重/题族/资格/持久 attempt）在**真卷体量下变 load-bearing**（§3）。
5. **获取前端方案**：不用外部 hermes，用 Loom 现成 **Claude Agent SDK**（`runner.ts`）+ 浏览器工具；owner 选 **全自动（A）**；认证墙是真正的 crux（§4）。
6. **一份真卷 spike**：获取导航✅、学科网=干净文本 DOCX✅✅、Loom docx 文本线零-OCR✅、pandoc 完美✅、切块 21→**24**（修 bug 后）✅、入池安全叫停⏸️（§5–§6）。

---

## 1. 参考实验室评估 → `port-selectively`

`codex/provider-neutral-adapter`（隔离 git 仓，未推送，~28k src / 45k test LOC，1265 test 全绿）验证「evidence-inventory 供题控制面」形状是否值得引进 Loom。**默认结论非 Go**。

四层价值：
- **(a) 经验/决策 — MEDIUM**：唯一吃真实脱敏生产 trace 的一块。**19 次 engine/panel 分歧 → 证伪「engine verdict = truth」、坐实独立 review 必要性**；但区分「新控制面」的 5 个机制（familyDistinctness / targetConformance / qualificationPolicy / automaticRecovery / singleFlightConcurrency）在真实 trace 前**全部 UNRESOLVED**。
- **(b) 可复用资产 — MED-HIGH（是 DESIGN 不是 CODE）**：确定性 kernel + PG 并发 pattern 概念可移植；但 adapter 代码 single-shot/tool-less，与 Loom agentic `quiz_gen` 不兼容，**几乎无代码原样落地**。
- **(c) 流程框架 — HIGH**：Go/Simplify/Stop charter 本身是可复用方法论。
- **(d) 期权 — LOW**：Phase-6 n=1 canary（≤6 call/$1）买不到能翻动 5 个 UNRESOLVED 的证据。

**处置：归档 spike 为 reference，把 DESIGN 增量重构进现有 `src/server/question-supply/`，别再投 Phase-6 canary。** 对抗性 skeptic + advocate 双席独立收敛到同一处置。

---

## 2. 现行 vs 新建供题线：区别在「记忆与治理」

现行供题线（`src/server/question-supply/`）已经跑通：
- `target-discovery.ts`：确定性 4-rule 扫描器（R1 coverage-depth<2 / R2 source_quality / R3 near-θ̂ diagnostic / R4 format_diversity + confusable），θ̂/难度档/来源档感知，产出 `QuestionSupplyTarget`。**已修** design doc 抱怨的「scanner scope 恒空」（`loadFrontierKnowledge` 现扫全部 active-goal KC）。
- `route-planner.ts` → `dispatcher.ts`（薄 IO：`boss.send('sourcing'|'quiz_gen')` + 7d query-cooldown；`ingest_existing` 路由是**未建占位**）→ 既有 job → verify。

「新建」控制面**保留这条脊柱**，加的是它之后的一切：

| 轴 | 现行 | 新建 |
|---|---|---|
| Target | ephemeral（每扫算一次，不落库、无版本） | 持久 + versioned（expire/supersede/reopen） |
| 库存 | raw 可用题数 ≥ 2 | 独立题族容量（family + eligible/reserve/pipeline/exposure-blocked/unqualified） |
| 在制 | 7d cooldown（无表） | CONWIP + base-stock + single-flight |
| Attempt | 无（fire-and-forget） | 持久 ProductionAttempt（lease/预算/分类重试） |
| 因果链 | 无 | target→attempt→revision→trace 全透传 |
| 信封 | 萎缩（dispatch 只转 count/kid/kind/gen_method） | plan-then-generate 完整 item plan |
| 资格 | draft_status + 来源档 | multi-axis Qualification + allowed-use |

**差别是「补题之后系统记不记得、管不管得住」，不是「会不会发现缺口」。**

---

## 3. 需不需要新供给线？—— **看获取侧**

**没有 学科网 之前**：n=1 单用户、~2 auto route、夜间低量、能容忍一天补货延迟——**每一条都命中设计权威自己写的「reconsider/Simplify」条件**（research doc §结尾）。而 spike 证明「新形状更好」的 5 个机制全 UNRESOLVED。→ 建 20k-LOC 子系统 = 项目标志性的**建成不通电**。

**有了 学科网 真卷获取路，calculus 变了**。真卷批量流入时，之前判「过度」的机械变 **load-bearing**：
- 跨试卷**近重/共享刺激材料**（二次函数-差常数项）→ 强制**去重门 + 题族容量**（raw-count 严重高估覆盖）。
- 真题 = 高 provenance → **分层资格 / allowed-use** 变真（placement-anchor / mastery-evidence grade vs LLM 变体 vs draft）。
- 浏览器获取慢且脆（session/页面漂移/下载失败）→ **持久 attempt + 因果链 + 恢复/lease** 变 load-bearing（design doc「来源断网」场景）。
- 唯一**变得更不急**的：verified-item-model（参数化 LLM 变体）——真题一来其立论消失。

---

## 4. 获取前端：SDK 取代 hermes，认证墙是真 crux

**不用外部 hermes——用 Loom 现成的 Claude Agent SDK。** `src/server/ai/runner.ts`（`@anthropic-ai/claude-agent-sdk` v0.3.168）就是一个通用 tool-call 循环（`query()` + `mcpServers` + `allowedTools` + `canUseTool`）；`sourcing` 已经这么挂 **Tavily MCP**（`src/server/ai/mcp/tavily.ts`）去 web 找题。**加一个浏览器 MCP = 同一个动作。** 一个 SDK task 天生就是可调用的 service（就是一个 pg-boss job 跑 `query()`）——这**溶解了「hermes 能不能 service 化」那个 crux**。

**但 SDK 解的是「谁驱动 + 可不可调用」，不解「认证」。** Tavily 干净是因为它是 hosted MCP + 无状态 API key；学科网 无 MCP、无 API，浏览器工具是净新（repo 里今天**零**浏览器工具），且带**有状态的登录态**复杂度。

**Owner 决定：全自动（A）。** 真正的分水岭：
| | A 全自动（选定） | B 半-attended |
|---|---|---|
| 浏览器 | worker 容器内 headless（Playwright/Chromium） | 你桌面已登录 Chrome |
| 认证 | **存 学科网 凭证 + 扛 CAPTCHA/反爬**（真 crux） | 用你真实登录态，零存储 |
| 本质 | 真·无人值守 | 内部脑 + 你的手 |

→ 「完全内部化 + 夜间无人值守」**必然吃 A 的认证墙**。SDK 让编排内部化，认证那一下还是撞同一堵墙（spike §5 里提前现形）。

**Linchpin 已验证 ✅（2026-07-13 headless probe）**：Playwright **headless Chromium** + owner 导出的 学科网 session cookie（21 个，`.zxxk.com`，含 `xk.passport.*` SSO 令牌 + `xkw-device-id` + Aliyun WAF `acw_tc`/`aliyungf_tc`/`alicfw`）→ **学科网 完整登录态渲染**（`xkw_087879446`、个性化通知、无 captcha/WAF 拦截）。结论：**服务端 headless 会话复用成立，全自动 (A) 技术可行**。三条诚实边界仍在：① 只验了**认证**（登录态首页），**下载流**（p.xkw.com + 券 + 文件）headless 待补验；② **会话 TTL 未知** → 全自动现实 = 无人值守抓取 + **周期性人工重登**（`xk.passport.*` 过期决定频率），非零-touch-forever；③ 跑在 host macOS 非 linux 容器（同引擎同机同 IP，强代理，建时容器内复验）。**红线守住**：全程未输密码、cookie 用完即删、剪贴板已清。

---

## 5. 学科网 获取 + 治理 · Phased 设计（草案）

**Loom 已经拥有下游那半。** 一份 学科网 PDF/DOCX → 现有 ingestion 管线（`src/capabilities/ingestion/`）：OCR（`glm_ocr`/`tencent_mark`）/ DOCX 文本线（`api/docx.ts`）→ 结构抽取（`block-assembly`/`structure`）→ `make-paper`（试卷-as-unit 已存在）→ `auto-enroll.ts`（INSERT question + draft_status 门）。tier-1 溯源**自动白给**（`deriveSourceTier` 只认 `metadata.ingestion_session_id`，`provenance.ts:136`）。所以这不是「建新供给线」，是**获取前端 + 治理层**拼在已有管线上。

### Phase 1（定向补缺口 · 验证）— 最小
- **Seam**：Phase 1 **不把 学科网 login 塞进 worker**（那是不通电陷阱）；先验抽取质量 + seam 本身。
- **最小治理三件**：① 因果链 = 事件总线（`writeEvent` + `caused_by_event_id`，零新表）；② **精确 `content_hash` 去重门**（两个 INSERT 点：`auto-enroll.ts` + `import.ts`；`audit:draft-status` 强制每 INSERT 显式 set）；③ **极薄 acquisition-intent 标记表**（`{pending, landed, declined, failed}`，无 lease、无生命周期机器）。
- **溯源**：`provenance.ts` 加 `acquired`/zxxk 契约块，thread 进 `source_document.provenance` jsonb（零 DDL）。P1 仅归因，**不因 tier-1-alone 授予 placement_anchor**。
- **不上 structural_signature**（column-before-spike 倒序）；P1 期间用真卷做归一化 spike，P2 才落列。
- **Go/no-go 阈值**：跑 ≥3 份真卷，① ≥70% block 无人工修复落 `draft_status='active'` ② 公式/记号密集题抽检保真 ③ seam 无阻塞 → 开 P2；否则整角度重估。

### Phase 2（批量建库 · 治理）— 仅体量触发
| 加什么 | Loom primitive |
|---|---|
| family-capacity 库存 | 新 `question_family` 表 + variant_of/shares_stimulus/near_duplicate 边（复用 `confusable_with` mesh 先例）；R1 计数 `COUNT(questions)`→`COUNT(distinct families)` |
| structural 去重 + 夜间 embedding reconcile | `question.structural_signature` + clone `kc_dedup_nightly.ts`（knowledge→question），复用已有 `question.embedding vector(1024)` 作 recall（永不单独裁决） |
| 分层资格 / allowed-use | 纯 `deriveAllowedUse(...)` derive-on-read + versioned `qualification` 表 |
| 持久 attempt / CONWIP / recovery | **仅当 hermes/SDK-agent 进 worker**：完整 `production_attempt` + outbox poll/recovery clone 自 `memory/triggers.ts`（`SELECT FOR UPDATE SKIP LOCKED` + `fromPgBossDrizzleTx` + hourly sweep）+ per-route CONWIP |

**保持 deferred**：verified-item-model（真题一来立论消失）。

### 复用 vs 真新
- **100% 复用**：`api/pdf.ts`、`api/docx.ts`（文本线 pandoc→markdown→segment）、`persist-image-asset.ts`（SHA-256 内容寻址 R2）、`make-paper.ts`、`deriveSourceTier` tier-1、`writeEvent` 事件总线、pg-boss v12 + `fromPgBossDrizzleTx` transactional-outbox idiom（ADR-0021）。
- **P1 真新（最小）**：provenance thread-through（零 DDL）+ `content_hash` 列 + 精确去重门 + 极薄 intent 标记表。

---

## 6. Spike 实证（一份真卷，端到端）

目标卷：金山中学 高一语文期末（150 分/24 题：古诗文默写 / 语用 / 现代文阅读×2 / 诗词 / 文言文 / 作文），学科网 精品解析卷。

| 阶段 | 结果 |
|---|---|
| ① 获取导航 | ✅ agent 驱动浏览器：搜索→详情→免费下载→确认→消耗 1 张券，真实会员下载完成 |
| ② 认证 | ⚠️ 扩展的 Chrome 初始未登录学科网（须手动登录）= 全自动路 worker 侧要解的墙，提前现形 |
| ③ 文件交接 | ⚠️ 文件落扩展 Chrome 下载目录（shell 初始看不到）= 半-attended 税；**全自动 worker 路无此问题**（浏览器+ingestion 同容器） |
| ④ 格式 | ✅✅ **重大 de-risk**：精品解析卷 = 干净文本 DOCX（原卷版 50KB + 解析版 66KB），**非扫描图** → Loom docx **文本线，零 OCR**。设计 #1 风险（OCR 毁公式）对语文卷**根本不成立** |
| ⑤ 转换 | ✅ 用容器内 pandoc（Loom 真实转换器，YUK-258 文本线：gfm + extract-media）EXIT=0，282 行干净 markdown，题号/选项/阅读全文/默写空格全保留，3 张图抽出 |
| ⑥ 切块 | ✅ `segmentMarkdown` **24 题 → 24 块**（修 bug 后；修前 21，3 处合并）内容零损坏 |
| ⑦ 入池 | ⏸️ 安全叫停：live :8787 `AUTO_ENROLL_ENABLED=true`，POST 会真插进池；守「observe 才跑」承诺**未 POST**，改离线跑通抽取，**池未动** |

**净结论：gate 全局的抽取半 = 绿灯（语文）。** 最怕的 OCR 噩梦不存在——学科网 语文卷是文本 DOCX，Loom 早有专线（YUK-258 注释直写「语文/纯文本卷」），pandoc 完美，切块可用。剩的活：切块边界硬化（§7 已修一处）+ 获取侧认证工程（§4 的 A 路）。

**未验证的更坏情况**：数学/物理卷含 MathType → Loom docx **visual 线**（LibreOffice→PDF→OCR）——这条 OCR 保真度**本 spike 未测**，是下一个该验的点。

---

## 7. 切块边界修复（本次代码变更 · 已 TDD + 实证）

**Bug**：`markdown-segment.ts` 的 `QUESTION_LEADING = /^\s*(\d{1,3})\\?\.\s+(.*)$/` 要求点号后有 `\s+` + 同行正文。学科网 有些题 pandoc 把题号单独成行、正文放下一行：
```
8\.
第⑭段画线句的对话描写…
```
于是 bare `8\.` 行不匹配 → 落进上一题 prompt → **Q8/Q13/Q23 静默并进前一题**（真卷 21/24）。

**修复**：把同行正文改为**可选**（`\d{1,3}` 已挡 4 位年份如 `1991.`）：
```ts
const QUESTION_LEADING = /^\s*(\d{1,3})\\?\.(?:\s+(.*))?$/;
// 循环内：bare 行 q[2] 为 undefined → promptLines 起空，后续行经 fall-through 填入
```

**验证**：
- 新增 2 个 TDD 单测（`markdown-segment.unit.test.ts`「bare question-number line」），修前红、修后绿；全文件 **14/14** 通过。
- 真卷离线复跑：**21 → 24 块**，`question_no` = `1,2,…,24` 无缺口，Q8/Q13/Q23 各自独立块。
- biome 干净；`.unit.test.ts` partition 正确。

**触及文件**：`src/capabilities/ingestion/server/docx/markdown-segment.ts`（regex + 循环）+ 同名 `.unit.test.ts`（2 新测）。**纯确定性、零 LLM、零新依赖。**

---

## 8. 开放决策（待 owner）与 Follow-ups

### Open forks
- **(a) hermes↔Loom seam**：**已定 = 全自动（A）**；「学科网 登录态能否脱离你 Chrome 搬进服务端 headless 浏览器」这个**能力事实已验证 ✅**（2026-07-13 headless probe，见 §4）——服务端 headless 会话复用成立、WAF 未拦。**剩下是工程不是未知**：worker 容器装 Chromium + 会话刷新机制 + 下载流 headless 复验。
- **(b) P1 去重深度**：lean = exact `content_hash` only（structural 留 P2）。
- **(c) 溯源→资格**：lean = P1 仅捕获归因，P2 才授信 mastery/placement。
- **(d) verified-item-model**：lean = defer。

### Follow-ups（已落账：YUK-676）

> 2026-07-17：四项已按轻量 capture 方案写入 YUK-676 checklist，并补齐设计锚点、
> 代码落点与 owner gate。某项进入实施时再晋升为独立 sub-issue；P1 治理三件仍以
> fork (b)/(c) 获 owner 采纳为前提，不将 capture 冒充批准。

1. **阅读篇父题分组**（passage → composite parent）进 docx 文本线：现读文原文被吸进相邻题块（`compositeParentOnly` 概念已存在）。**下一个切块增量。**
2. **数学/物理 MathType 卷** OCR-visual 线保真度验证（本 spike 未测的更坏情况）。
3. **全自动获取的认证工程**（worker 侧 headless 浏览器 + 学科网 session/凭证 + 反爬 + 文件交接）。
4. **P1 落地三件**（若采纳）：`content_hash` 列 + `audit:schema` allowlist、intent 标记表 migration、provenance thread-through。

---

## 附：关键 file:line 索引
- 现行供给：`src/server/question-supply/{target-discovery,route-planner,dispatcher,refill}.ts`
- Ingestion：`src/capabilities/ingestion/api/{docx,pdf,sessions,import,extract,assets}.ts`；`server/{auto-enroll,make-paper,docx/markdown-segment,docx/convert}.ts`；`src/server/session/docx-ingestion.ts`
- 溯源/资格：`src/core/schema/provenance.ts:136`（tier-1）
- Infra：`src/server/memory/triggers.ts`（ADR-0021 outbox）、`src/server/events/queries.ts`（`writeEvent`）、`src/server/boss/client.ts`（pg-boss v12）、`src/server/ai/{runner,mcp/tavily}.ts`（Agent SDK + MCP）
- 参考实验室：`/private/tmp/question-supply-control-plane-phase1-2`（隔离仓，port-selectively 归档）
