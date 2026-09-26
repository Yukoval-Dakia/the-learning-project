# YUK-1007 — 统一配置面板 UI preflight（source-check only）

日期：2026-09-26 · 关联 YUK-1007 · **状态：设计方向待 owner 正式批准；本文件不含任何 UI 代码**

输入：[配置面普查](../planning/2026-09-26-yuk1007-config-surface-census.md)（基线 `git HEAD = 6d87cebb9`）。
格式参照：[YUK-1038 作答面 preflight](2026-09-24-assessment-ui-preflight.md)。

## 0. 状态与边界

- 本文件是 **source-check only**：给出普查原文引用、组件类型、信息架构、交互与文件清单；**不构成质量、运行时或可达性证明**。
- 本文件**不写任何 UI 代码**；无 route / 组件 / 样式新增。
- 后端读面（read model）与写面仅**枚举**（非 UI writer scope），见 §10。
- 存储方案（census §3 storage options）由 owner 在批准后另行拍板；本设计按 census 推荐的 **storage-3 混合**（secret 留 env，flag / per-task override / locale / threshold 进 DB）排版 P1 写路径，但不锁 schema。
- 遵循 owner directive：**P0 只读「配置一览」先行**，写路径 P1。

## 1. 逐字普查 / 规则原文（verbatim；由 read 取得，含路径与行号 / §）

### 1.1 普查 · owner 核心目标面

`docs/planning/2026-09-26-yuk1007-config-surface-census.md` §1.A 表头行（line 23）：

```
| TaskSpec × 52 | provider 全部 `xiaomi`；41× `mimo-v2.5-pro` + 11× `mimo-v2.5` | `src/ai/task-catalog.ts:104-117`（期望数 52）；各 `src/ai/tasks/*.ts`（33 个文件） | 模块加载 freeze | 全部 AI task dispatch | rebuild | P1 writable（per-task model/provider/budget） | 高：核心能力面，改错影响所有任务 |
```

§1.D `LEARNER_LOCALE_PIN` 行（line 122）：

```
| `LEARNER_LOCALE_PIN` | 硬编码简体中文后缀，附加到**每个** task prompt | `src/ai/task-prompts.ts:30-46` | 每次 prompt 构建 | rebuild | P1 writable（= per-user locale 落点） | 高：全局语言行为 |
```

### 1.2 普查 · 缺口与冲突（设计直接依据）

§2 缺口 1（line 194–196）：

```
1. **没有 "what is running now" 读面。** flag 向量只在 boot 时经
   `warnFlipOrder` 打日志；无任何 route/endpoint 暴露当前生效的
   flag/threshold/model 解析结果。面板要 view-only 也得先建这个读面。
```

§2 缺口 5（line 207–212）：

```
5. **per-task model/provider 当前是编译期 freeze。** TaskCatalog
   `Object.freeze`；52 个 task 的 model/budget 改动=发版。YUK-1007 的核心
   需求（面板改 per-task 模型）需要一条 override 读路径插进
   `resolveTaskProvider`（`providers.ts:508-608`），该函数已有
   `override arg > env > registry default` 三级链，加第四级（DB）是
   最小侵入点。
```

§4.1（line 280–286）：

```
1. **compose `environment:` 静默压过 .env。** `docker-compose.mac.yml` 对
   app+worker 硬设 `PLACEMENT_PROBE_ENABLED`/`WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED`/
   `MISCONCEPTION_PROMOTE_ENABLED="true"`；`docker-compose.yml` 强制
   `MEM0_TELEMETRY=false` + per-service `MEM0_HISTORY_DB_PATH`（app `/tmp`
   vs worker `/var/lib/mem0` volume）。真实 env 优先于 .env 文件
   （`server/env.ts` loader 只填 unset）——面板上显示的 ".env 值" 可能
   根本不是生效值。**读面必须读进程 env，不能读文件。**
```

§4.2（line 287–290）：

```
2. **boot-const 假开关风险。** module-load 期求值的 reader
   （`PLACEMENT_PROBE_ENABLED` at `placement.ts:42`、`MATCH_THRESHOLD`、
   `KC_DEDUP_*`、boss pool 等）在面板里若标成"可切换"是误导：写入后
   当前进程行为不变。每条目需带 `生效时机` 元数据。
```

§4.6（line 304–305）：

```
6. **YUK-1033（学段纠正入口）** 明确 parked 等待本面板 —— 面板信息
   架构需预留"学段/纠正"入口位。
```

§3 P0 候选集（line 225–235）：

```
### P0 — view-only（只读展示，第一批就能上）

- 当前生效 flag 向量（27 ledger + ~10 台账外，标注 env/const/opt-in-out）
- per-task model/provider/budget 解析结果（52 行表，= resolveTaskProvider
  输出物化）
- provider 注册表状态（8 provider，哪些有 key、哪些 reserved）
- cron schedule 总表（§1.F）
- 运行形态（port、db pool、queue tier 常量）
- const flags（学术开关，写明 rebuild-only）

前置依赖：新建 "current config read model"（缺口 §2.1）。
```

### 1.3 仓库规则原文（preflight gate 与壳层惯例）

`AGENTS.md:36–44`（UI design pre-flight）：

```
## UI design pre-flight

写任何 UI 代码前，先向用户提交并等待批准：

1. 逐字引用相关 design doc，给路径与行号/章节。
2. 声明组件类型：drawer / route / modal / page / other。
3. 列出将创建和修改的文件。
```

`web/AGENTS.md:15–17`（CONVENTIONS）：

```
- **capability ui 不 import 路由库**。导航以 `(to: string) => void` prop 由 `web/src/router.tsx` 注入；capability 包只负责页面组件。
- 页面组件放在 `src/capabilities/<name>/ui/`，在 `web/src/router.tsx` 统一 import 并绑定路由。
- 全局 chrome（sidebar/topbar/CopilotDock/CommandPalette）属于 `web/` 壳层，不归 capability 包。
```

`src/capabilities/observability/AGENTS.md`（CONVENTIONS 首条）：

```
- admin 路由照常套主 chrome（`web/src/router.tsx` RootShell）；不另设 admin 独立壳。
```

`src/capabilities/observability/ui/subjects.tsx:8–11`（RL5 红线，admin 读面先例）：

```
// ── RL5 — 列表页零写按钮 ────────────────────────────────────────────────────────
// This surface is READ-ONLY. 写动作全部集中 detail 页（/admin/subjects/$id），
// 且一律经 /api/admin/*（x-internal-token gate）。
```

### 1.4 语言面消费者原文（ticket 所称 "proposal-reasoning-english" 的实际落点）

`src/ai/task-prompts.ts:24–31`：

```
// Free-generated user-visible fields (proposal reasoning / reason_md, judge
// explanations, intervention copy, chip 文案) previously drifted to the model's
// default language. The pin covers user-visible text only — structured output
// (JSON keys, enum values, LaTeX, code) is unaffected. UI locale is currently
// hardcoded 简体中文; per-user locale plumbing is the settings-panel ticket's
// long-term scope (YUK-1007).
export const LEARNER_LOCALE_PIN =
  '\n\n【输出语言】所有面向用户展示的文本（回复正文、reasoning / reason_md、解释摘要、提案理由、chip 与卡片文案等）一律用简体中文书写；JSON 字段名、枚举值、代码与 LaTeX 记号不受影响。';
```

**核查结论**：仓库中不存在名为 `proposal-reasoning-english` 的符号或文件；ticket 所指的消费者就是 pin 注释里的 "proposal reasoning / reason_md … drifted to the model's default language" 这组自由文本字段。面板语言区要展示的是 **pin 的生效状态与覆盖范围**；P1 的 locale 写字段最终替换这段硬编码 pin（详见 §12 报告项 3）。

## 2. 组件类型与范围（声明）

- **类型：新增一条 route（kind: page）**，route 路径 `/admin/config`，surface id `admin-config`，owner `observability`，照常套主 chrome（RootShell）。页内分区用既有 `TabBar` primitive + `?section=` 查询串（replace 语义，与 `RecordPage` / `PracticeFacePage` 的 getQuery/setQuery 协议同构）。
- **不新增 drawer / modal**。P1 的确认交互复用 `subject-traits.tsx` 的行内确认条模式（`confirming` state + 文本说明 + 显式按钮），不引入新 modal 组件。
- **理由**：
  1. 内容密度（~40 运行时旋钮 + 52 行 TaskSpec + 27+10 flag + 15+ cron + 8 provider）远超 drawer/modal 合理容量；现有 admin 面（runs/cost/failures/subjects/coverage-lattice/conjecture-scores）全部是 page，配置面板是同族运维读面。
  2. 可达性已成型：侧栏 footer「Admin」入口（`AppSidebar.tsx:144–152` → `/admin/runs`）+ admin 页间互链行（`observability-shared.tsx` `AdminLinks`）+ 命令面板 search 声明；新页只需加入这三处既有通道。
  3. census §4.6 要求的 YUK-1033 预留入口位，page 分区是自然宿主。
  4. `?section=` 深链可直接从命令面板 / 其他 admin 页跳到具体分区。
- **只用现有 tokens/primitives**（§7 清单）；不新增设计 token、不新增组件语言、不动 `globals.css`。

## 3. 信息架构

### 3.1 分组决策：per-type 为主轴 + per-capability 过滤 + 页内搜索

- **主轴按类型分组**（flag / AI 模型 / 阈值 / 语言 / 调度运行），不按 capability 分顶区。理由：`生效时机` 与可写性语义按类型聚簇（env flag 一组重启语义、TaskSpec 一组 freeze/override 语义、const flag 一组 rebuild 语义），同区共享同一套徽标图例与（P1）同一类写路径；按 capability 分顶区会把同一 mutation model 拆到五处。
- **capability 作为过滤轴**：功能开关区与 AI 模型区内设 owner 过滤 chip 行（全 / practice / ingestion / knowledge / notes / agency / copilot / server），解决「只看 practice 用的」视角而不复制行。
- **页内文本搜索**：页头右侧一个过滤输入框，对当前分区行做 name / owner / note 子串过滤；纯客户端，不造新组件。

### 3.2 分区（6 个 tab；P0 全部只读）

| # | section id | 标题 | 内容（P0 数据来源见 §10） |
|---|---|---|---|
| 1 | `overview` | 总览 | 计数卡：flag 开/关数、compose 强制项清单、provider 有 key 数、活跃 override 数（今天=0，如实显示）、进程标识（app pid / boot 时间）、**worker 一致性问题：如实标「未通电」**（§6.4） |
| 2 | `flags` | 功能开关 | 27 ledger flag + ~10 台账外开关全表：生效值 / 默认 / opt-in-out / env-or-const / 来源 / 生效时机 / owner / 风险 / 声明处 |
| 3 | `ai-models` | AI 模型 | ① 52 行 TaskSpec 表（kind / owner / provider / model / budget 四字段 / 解析层级）② 8 provider 注册表（key presence 布尔，绝不序列化 secret）③ scoped override 组（VERIFY_SOLVE / VISION_JUDGE / JUDGE_FALLBACK / JUDGE_CALIBRATION）+ 全局 `AI_PROVIDER_OVERRIDE` 状态（unset 如实显示） |
| 4 | `thresholds` | 阈值与旋钮 | env-tunable 阈值组（`WORKFLOW_JUDGE_AUTO_ENROLL_THRESHOLD`、`COPILOT_NUDGE_*`、`KC_DEDUP_*`、`TAGGING_MATCH_*`、`JYEOO_*`、`MEM0_*` 模型/dims 等，含 clamp 区间）+ hardcoded const 组只读摘要（queue tiers / orchestration / 学习模型参数，标 rebuild-only） |
| 5 | `locale` | 语言与学习者 | `LEARNER_LOCALE_PIN` 生效状态与覆盖范围（引 §1.4 注释原文）、UI `zh-CN` 硬编码 ×4 清单、`Asia/Shanghai` cron tz、per-subject `languageStyle`（链接出到既有 `/admin/subjects/$id`，不重复造编辑面）、UI i18n=future tag（范围外）、**YUK-1033「学段与纠正」预留入口位**（占位卡 + parked 标注） |
| 6 | `runtime` | 调度与运行形态 | 15+ cron schedule 总表（名称 / cron / tz / owner / 来源）+ 运行形态常量（port、db pool、queue tier、orchestration anchor） |

### 3.3 密度承诺

配置面是天然密集面——**committed controlled density**：表格 + mono 值列 + meta 字号，与既有 admin 面同密度档；不做卡片化稀疏排版，不做营销式视觉。总览区是唯一例外（计数卡用既有 `Card`）。

## 4. Phase 划分

### 4.1 P0 — 只读「配置一览」（本批交付）

- §3.2 六个分区全部**只读**；全页零写控件（沿用 RL5 红线的页面级版本——渲染测试断言无 mutation hook，见 §11-8）。
- 每行携带统一元数据（读面契约，§10.2）：`生效时机` / `来源` / `风险` / `可写性阶段` / `声明处 file:line`。
- 前置依赖（非 UI scope）：`GET /api/admin/config` 读面（census 缺口 §2.1），读**进程 env** 而非文件（census §4.1）。

### 4.2 P1 — writable（第二批；每类写项的生效时机/scope 标注先行）

| 写项类 | 生效时机标注（UI 如实显示） | scope 标注 |
|---|---|---|
| per-task provider/model override | **下次调用生效**（`resolveTaskProvider` 每次调用执行；插入第四级 DB override 后成立，census §2.5） | 单 task；app+worker 双进程天然一致（DB 读） |
| per-task budget override | **依赖 budget 读路径改造**——TaskSpec 是模块加载 freeze（census §1.A），未改造前 UI 标「重启生效」且禁用写入 | 单 task |
| scoped model override（VERIFY_SOLVE / VISION_JUDGE / JUDGE_FALLBACK / JUDGE_CALIBRATION_REJUDGE） | 现为 env+restart；迁移到 DB 后「下次调用生效」，迁移前禁用并标「重启生效」 | 单 lane |
| env flag 组（B1 + `HUB_SYNC_MODE` / `INTERVENTION_DISABLED_METHOD_IDS` / `EXTRACT_OCR_ENGINE`） | **按 reader 类型逐条标注**：per-call reader →「下次调用生效」；module-load 快照（`PLACEMENT_PROBE_ENABLED` 等，census §4.2）→「重启生效（启动期快照）」；reader 未迁移 env→config 前该条写控件禁用 | app+worker 双进程（DB 天然解决 parity，census §4.3） |
| 阈值组（`WORKFLOW_JUDGE_AUTO_ENROLL_THRESHOLD` / `COPILOT_NUDGE_*`） | 同上按 reader 标注；clamp 区间内联显示 | 全局 |
| 语言：AI 输出语言 | per-learner locale 字段（DB）→「下次 prompt 构建生效」；`getTaskSystemPrompt` 改读 locale 前禁用 | 单 learner（当前单用户） |
| 语言：UI 语言 | **本批不可写**——无 i18n 框架（census §1.D），选择器 disabled + future tag | — |

- **compose 强制项特殊处理**（census §4.1）：`PLACEMENT_PROBE_ENABLED` / `WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED` / `MISCONCEPTION_PROMOTE_ENABLED` 被 compose `environment:` 硬设，进程 env 永远压过 DB——P1 中这三条**写控件禁用**，来源徽标 `compose 强制`，说明文案「此值由部署 compose 固定，面板改动不会生效；要改需改 compose 文件」。诚实优先于可写。
- const flag（B2 学术开关）与 hardcoded const（C.2）**永不进入写路径**：rebuild-only 徽标，P0/P1 均只读。

### 4.3 P2 — advanced（不在本设计文件展开）

`PROJECTION_IS_WRITER_*` / `SELECTION_POLICY` / `MEMORY_RECONCILE_HANDOFF_MODE` / admission enforce / 全局 `AI_PROVIDER_OVERRIDE` / rate limits / `MEM0_*` dims / per-job 启停——P0 仅以只读行 + 风险徽标出现（落在 flags/thresholds 区），P1 不写。

## 5. P1 每类写项的 UI affordance 与 mutation path

| 写项类 | UI affordance（不新增组件语言） | mutation path | 前置后端 seam | 危险确认模式 |
|---|---|---|---|---|
| per-task provider/model | 行内「编辑」→ 行内编辑态：provider 用既有 `TabBar` seg 形态列**有 key 的 provider**（无 key 的禁用+原因）；model 用原生 `<input list>` + datalist（已知 model 清单）；保存/取消按钮用既有 `Btn` | `PATCH /api/admin/config/task-overrides/[kind]` → DB override 表 → `resolveTaskProvider` 第四级 | **需要**（census §2.5 最小侵入点） | 高风险：行内确认条 + 变更前后 diff 摘要 + 「恢复 registry 默认」按钮；跨 provider 时复用 `providerRequiresExplicitModel` 校验结果内联提示 |
| per-task budget | 同上编辑态内四个 number input（含 clamp 提示） | 同上 | budget 读路径改造（未改造前禁用） | 中风险：确认条 |
| scoped override 组 | 组内每 lane 一行，同 per-task 控件 | `PATCH /api/admin/config/lane-overrides/[lane]` | env→DB 迁移（与 per-task 同机制） | 中风险：确认条 |
| env flag | 两档 seg 控件（开 / 关，复用 `.seg` 类，**不新增 Toggle 组件**）；opt-in/out 语义在文案中写明（「默认开，可关」/「默认关，可开」） | `PATCH /api/admin/config/flags/[name]` → DB config 表；reader 逐个 env→config 迁移 | 每 flag 的 reader 迁移（真实迁移工作量，census §3 storage-3）；未迁移=禁用 | 按风险分档：低=直接生效；中=确认条；高（`HUB_SYNC_MODE` apply、`MISCONCEPTION_*`、`WORKFLOW_JUDGE_*`）=确认条 + 影响面文案；compose 强制=禁用 |
| 阈值 | number input + min/max clamp 内联 + 保存按钮 | 同 flag | 同 flag | 中风险：确认条（`WORKFLOW_JUDGE_AUTO_ENROLL_THRESHOLD` 影响 auto-enroll 面） |
| AI 输出语言 | seg 选择（简体中文 / English；首版两档） | `PATCH /api/admin/config/locale` → per-learner locale 字段 | `getTaskSystemPrompt`（`task-prompts.ts:34-46`）改读 locale 替代硬编码 pin | 高风险（全局语言行为）：确认条 + 「作用于所有 task prompt」文案 |
| subject `languageStyle` | **不在本页编辑**——行链接出到既有 `/admin/subjects/$id` 编辑面 | 既有 `/api/admin/subjects/*` | 无（已通电） | 沿用既有面 |

全部写动作：经 `/api/admin/*`（x-internal-token gate，既有 `apiJson` 自动带 token）；留痕遵循 `admin-trait-journal` 既有审计先例（每次写记 journal，谁/何时/前后值）。

## 6. 交互细节

### 6.1 徽标体系（复用 `Badge` tone，语义映射固定）

| 徽标 | 取值 → tone |
|---|---|
| 生效时机 | 每次调用生效=`good`；重启生效=`hard`；启动期快照（重启生效）=`hard`；改代码生效（rebuild-only）=`neutral`；DB-live（≤60s）=`info`；脚本专用=`neutral` |
| 来源 | 进程 env=`info`；compose 强制=`again`；代码默认=`neutral`；DB=`good`；未设置（unset）=`neutral` |
| 风险 | 高=`again`；中=`hard`；低=`neutral` |
| 可写性 | P1 可写（未来）=`info` 描边文案；rebuild-only / 不上面板=`neutral` |

每个 tab 顶部一行图例说明（meta 字号），避免逐行解释。

### 6.2 生效值溯源显示

- 每行「来源」列只显示**生效层**（进程 env / compose 强制 / 代码默认 / DB）；hover/展开的 title 文案给出完整层级链「真实 env > compose environment > .env.local > .env > 默认」（census §4.7）。
- `.env` 文件值**不作为生效值展示**；P0 不读文件（census §4.1 红线）。
- compose 强制行在生效值旁加 `compose 强制` 徽标，文案：「部署层固定，改 .env 或面板都不会生效」。

### 6.3 空态与错误态（全部复用既有 primitive）

- 分区加载：`Stateful` status=loading → `SkLines`；错误 → `ErrorState` + 重试。
- 过滤无匹配：`EmptyState`，文案「当前分区无匹配『{keyword}』的条目」。
- 无活跃 override（P0 常态）：AI 模型区 override 组 `EmptyState`，文案「当前没有任何 override——全部走 registry 默认」，**不 fabricate 假 override 行**。
- 全局 `AI_PROVIDER_OVERRIDE` unset：行值显示「未设置」，徽标 `neutral`，不虚构默认值。
- YUK-1033 预留位：占位 `Card` + `EmptyState` 的 `futureTag`，文案「学段纠正入口（YUK-1033）——已 parked，等待本面板通电后接入」。
- 计数不确定时沿用侧栏 `?`/`N+` 诚实模式（`AppSidebar.tsx:113–123` 先例），不 fabricate 精确值。

### 6.4 app / worker 双进程诚实标注

- P0 读面只能读 **app 进程** env（worker 是独立进程 `scripts/worker.ts`，无 HTTP 面）。总览区进程卡如实标注：「以下生效值来自 app 进程；worker 进程一致性未通电（census §4.3）」。
- worker 心跳通电（worker 向 DB 写 config 摘要）列入 §10 后端枚举的 **P0 stretch / P1** 项；通电前任何行不得暗示双进程一致。

### 6.5 键盘与 a11y

- tab 切换用既有 `TabBar`（`aria-pressed` 已有）；`?section=` 深链可直接落分区。
- 表格 `<th>` 带 scope；徽标信息不止靠颜色——tone 同时配文案（「高」「重启生效」等文字本身在徽标内）。
- 过滤输入框原生 `<input type="search">` + `aria-label`。

## 7. 视觉语言（零新增）

- **tokens**：全部复用 `web/src/globals.css` `@theme` 既有变量——paper/ink/line 色系、`--color-coral` 单 accent、语义三色（again/hard/good）+ info、`--font-mono`（JetBrains Mono）用于 name/值/来源列、`--font-serif` 仅页头标题、meta/body 字号、4-pt spacing、hairline 表格。
- **primitives**：`PageHeader`（ eyebrow=`ADMIN · config` ）、`Card`、`Badge`（§6.1 映射）、`Stateful`/`SkLines`/`ErrorState`、`EmptyState`、`TabBar`、`Btn`、`LoomIcon`。表格样式沿用 `observability-shared.tsx` 的 inline tableStyle/thStyle 一族（`linkRowStyle` 同文件）。
- **壳**：`.page wide` + RootShell，与 admin 六页一致；admin 互链行加入 `config` 一项。
- **不做**：新组件、新 token、新色彩语义、opacity-gated 入场动画（遵 question-bank 红线）、卡片化稀疏排版。
- 色彩克制承诺：徽标是唯一语义色来源；表格本体零语义色。

## 8. 新增文件（P0；glob 已验证：均不存在 → NEW）

```
src/capabilities/observability/ui/config.tsx                  — 页面壳：PageHeader + TabBar + 过滤输入 + 分区路由 + 单 query
src/capabilities/observability/ui/config-sections.tsx         — 六分区渲染器（表格/计数卡/占位卡）
src/capabilities/observability/ui/config-model.ts             — 纯函数：读面 payload 类型、过滤/分组 helper、§6.1 徽标映射
src/capabilities/observability/ui/ConfigMetaBadges.tsx        — 生效时机/来源/风险/可写性四个徽标组件
src/capabilities/observability/ui/config-model.unit.test.ts
src/capabilities/observability/ui/config.render.unit.test.tsx
src/capabilities/observability/ui/ConfigMetaBadges.unit.test.tsx
```

（P1 增量文件属 preview，见 §12 报告项；不在本批创建。）

## 9. 修改文件（P0；glob 已验证：均存在）

```
src/kernel/ui-surfaces.ts                            — +admin-config surface 声明（route /admin/config、activeId 'admin'、search 声明「Admin · 配置」）
web/src/router.tsx                                   — import loader + createRoute（lazyNavigableRoute 先例）
src/capabilities/observability/ui-public.ts          — +loadAdminConfigSurface
src/capabilities/observability/ui/observability-shared.tsx — AdminLinks + config 一项
src/ui/shell/nav-config.ts                           — SURFACE_ICONS + 'admin-config' 映射（沿用 'settings'）
src/capabilities/observability/ui/subjects.tsx       — 内联 linkRow 改投 AdminLinks（去重）
src/capabilities/observability/ui/subject-traits.tsx — 同上
src/capabilities/observability/ui/coverage-lattice.tsx — 同上
src/capabilities/observability/ui/conjecture-scores.tsx — 同上
src/capabilities/observability/AGENTS.md             — WHERE TO LOOK 同步「admin 七页」与新文件
postman/api-endpoints.json                           — +GET /api/admin/config（随后 pnpm gen:postman）
```

说明：

- 第 6–9 项是**消重**而非扩散：普查未覆盖 UI 侧 admin 互链——`AdminLinks` 共享组件只有 3 页在用，4 页各持一份内联拷贝；新增第 7 个入口时统一收口，四页各删一段重复代码。若 owner 要求最小 diff，可降级为「四处各 +1 链接」，但推荐消重。
- `web/src/surface-inventory.unit.test.ts` 与 `src/capabilities/observability/manifest.unit.test.ts` **无需修改**：manifest `ui.pages = uiPagesFor('observability')` 自动投影新 surface，inventory audit（router 绑定 ↔ inventory ↔ manifest 三方对账）在 §9 三处改完后自动转绿。
- `src/ui/shell/nav-config.unit.test.ts` 无需修改（仅断言 breadcrumb 行为，admin-config 无 `showParam`）。

## 10. 后端依赖（枚举；非 UI writer scope）

### 10.1 P0 读面（前置依赖，census 缺口 §2.1）

```
src/capabilities/observability/api/admin-config.ts        (NEW) — GET /api/admin/config，x-internal-token gate
src/capabilities/observability/server/config-read-model.ts (NEW) — 读面装配
src/capabilities/observability/api/admin-config.db.test.ts 或 .unit.test.ts (NEW)
src/capabilities/observability/manifest.ts                (MOD) — 路由注册
```

读面装配要点（设计契约）：

1. **读进程 env，不读 .env 文件**（census §4.1）。
2. 数据源合并：ledger（`scripts/audit-flags-ledger.json` 27 flag）+ 台账外 ~10 项（census §1.B3 逐项清单）——census §4.5 的台账漂移问题，读面以**逐项枚举 + 声明处 file:line** 为准，ledger 仅作交叉校验，不把手工 JSON 当唯一真相源。
3. TaskSpec 物化 = 遍历 frozen `taskCatalog`（52 行）+ 标注每行解析层级（registry / env override）。
4. provider 注册表只输出 **key presence 布尔**——secret 绝不序列化（census §2.7「不能靠前端不渲染」）。
5. cron 清单从各 capability manifest + orchestration register 静态投影。

### 10.2 读面 payload 行契约（UI 消费形状）

```
{ name, effectiveValue, default, source: 'process-env'|'compose-forced'|'code-default'|'db'|'unset',
  effect: 'per-call'|'restart'|'boot-snapshot'|'rebuild'|'db-live'|'script-only',
  owner, risk: '低'|'中'|'高', writable: 'p1'|'p2'|'never', decl: 'path:line', note? }
```

分区 payload：`overview / flags[] / aiTasks[] / providers[] / thresholds[] / locale / schedules[] / runtime`。**单端点单 query**（payload 约数十 KB，60s refetch，与 admin 面 `refetchInterval: 60_000` 先例一致），不为六个分区开六个端点。

### 10.3 P1 写面与 seam（preview，非本批）

- DB config 表 + drizzle migration（storage-3 混合；secret 留 env）。
- `src/server/ai/providers.ts` `resolveTaskProvider` 第四级 DB override（MOD，census §2.5 指定的最小侵入点）。
- `src/ai/task-prompts.ts` `getTaskSystemPrompt` 改读 per-learner locale（MOD）。
- 各 flag/threshold reader 逐个 env→config 迁移（MOD × N，真实迁移工作量）。
- `src/capabilities/observability/api/admin-config-write.ts`（NEW）+ journal 留痕（`admin-trait-journal` 先例）。
- worker config 心跳（worker→DB 摘要，解决 parity 显示；P0 stretch / P1）。

## 11. P0 验收标准

1. `/admin/config` 三条可达路径全部成立：侧栏 Admin 入口 → admin 互链行（七页一致）、命令面板搜索「配置」直达、`?section=flags` 等深链落分区。
2. 功能开关区列出 27 ledger flag + ≥10 台账外开关；每行带生效值/默认/opt-in-out/来源/生效时机/owner/风险/声明处 file:line；单元测试断言行数 ≥37 且 B3 逐项在列。
3. AI 模型区 TaskSpec 表**恰 52 行**（测试断言计数），provider/model/budget 与 `resolveTaskProvider` 抽样输出一致；全局 override unset 时如实显示「未设置」。
4. provider 注册表 8 行，key presence 为布尔；契约测试断言响应体内**无任何 secret 材料**（key 值、token、DB URL 均不出现）。
5. `PLACEMENT_PROBE_ENABLED` / `WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED` / `MISCONCEPTION_PROMOTE_ENABLED` 三行带 `compose 强制` 来源徽标与说明文案。
6. 每条 module-load 快照项（`PLACEMENT_PROBE`、`MATCH_THRESHOLD`、`KC_DEDUP_*` 等）带「启动期快照（重启生效）」徽标；**全页无任何控件暗示可即时切换**。
7. 读面单测：生效值来自 `process.env` 注入值而非 .env 文件（mock 文件存在但进程 env 不同值时，显示进程 env 值）。
8. 渲染测试断言 P0 全页**零写控件**：无 `useMutation`、无 PATCH/POST 调用、无 enabled 状态的开关/保存按钮。
9. 语言区显示 pin 生效状态（含 §1.4 覆盖范围文案）、4 处 `zh-CN` 硬编码清单、per-subject `languageStyle` 链接出、UI i18n future tag、YUK-1033 占位卡带 parked 标注。
10. 总览区进程卡标注「app 进程生效值；worker 一致性未通电」；计数不确定时用 `?`/`N+` 诚实模式。
11. 加载/错误/过滤无匹配/无 override 四态分别走 `SkLines`/`ErrorState`/`EmptyState`，无 fabricate 行。
12. 视觉走查：与 admin-runs/cost 页并排无新组件语言、无新 token、mono 值列对齐、徽标文案不独靠颜色。
13. 本机 gate：scoped unit 测试（§8 三个测试文件）+ `pnpm typecheck` + `pnpm lint` + `pnpm build` 全绿；surface inventory audit 自动转绿；`pnpm gen:postman` 产物同步。
14. a11y：tab 键盘可达（`aria-pressed`）、表格 th scope、过滤框 `aria-label`；沿用既有 admin 面 a11y 测试模式补一例。

## 12. 普查未尽事项（设计过程中发现，如实报告）

1. **admin 互链行双轨漂移**：`AdminLinks` 共享组件仅 3/7 页使用，4 页各持内联拷贝（普查未覆盖 UI 侧 admin 导航）。本设计按消重处理（§9 第 6–9 项）；若 owner 只要最小 diff 可降级，但漂移会继续。
2. **worker parity 显示无现成数据源**：普查 §4.3 指出机制缺口，但 §3 P0 前置依赖只列了读面本身。设计结论：P0 总览区如实标「worker 一致性未通电」，worker 心跳（写 DB 摘要）列为后端 stretch/P1 项——不为此在 P0 造 IPC。
3. **「proposal-reasoning-english」在仓库中不存在**：grep 全仓零命中。ticket 所指消费者即 `LEARNER_LOCALE_PIN` 注释（`task-prompts.ts:24–31`）描述的自由文本字段组（proposal reasoning / reason_md / judge 解释 / chip 文案）——pin 本身就是该漂移的修复。语言区按「展示 pin 生效状态与覆盖范围」设计，无第二个消费者可链接（§1.4）。
4. **无 Toggle primitive**：现有 primitives 无开关组件。P1 flag 写控件指定复用 `.seg` 两档形态，**不新增 Toggle 组件**（§5）。
5. **MEM0 compose 强制项**（`MEM0_TELEMETRY` / `MEM0_HISTORY_DB_PATH` per-service 分叉）属 P2 区条目，P0 仅在阈值区以只读行 + `compose 强制` 徽标呈现，不展开 per-service 对比视图（留 P2）。
6. **`.env.example` help text 对齐**（census §4.4）：每行 note 可从 `.env.example` 注释取文案；P0 标为可选增强（读面附带 help text 字段时 UI 展示，缺省不占位），不阻塞首发。

## 13. 请求 owner 批准

- 请 owner 批准**一组**：**组件类型（§2）、信息架构（§3）、Phase 划分（§4）、P1 写项 affordance 与 seam（§5）、交互（§6）、P0 文件清单（§8–§9）、验收标准（§11）**。
- 本文件为 **source-check only**，**无质量/运行时声明**；不含任何 UI 代码。
- 存储方案（census §3 storage options）按 storage-3 混合排版但未锁 schema；P1 开工前需 owner 正式拍板。
- 批准后：P0 实施 = §8 新增 7 文件 + §9 修改 11 文件 + §10.1 后端读面（非 UI writer scope 可并行）。
