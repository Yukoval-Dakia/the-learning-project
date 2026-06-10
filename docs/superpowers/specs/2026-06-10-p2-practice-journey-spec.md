# P2 练习旅程 Spec — 流编排器 + 卷架 + practice 包

> **REV 2 改向声明（2026-06-10 晚，D17/D18/D19）**：本 spec 的 **P2a-P2d 分期作废**（P2a 已执行并 merge，PR #381）。
> **§2 概念设计继续有效**（流编排器 / 卷架 / 申诉重判链 / D15 / D16），由总 spec §4 的 **M2 练习流竖切**承接落地；
> §2.5 等价迁移清单与 §3/§4/§5 按总 spec REV 2 失效。见 `2026-06-10-architecture-redesign-design.md` REV 2 横幅。

> 2026-06-10 · 架构重设计 P2 阶段 spec · 状态：**待用户审阅**
> 上游：`docs/superpowers/specs/2026-06-10-architecture-redesign-design.md`（§1.6 流/卷概念模型、§2.3 包菜单、§4 P2 行）
> 原则：迁移即补深；每个子阶段结束系统完整可用（你每天还在用它复习——日用不断档是硬约束）。

---

## 0. 本阶段裁决记录

| # | 决策 | 裁决人 |
|---|---|---|
| D15 | 申诉补完自动重判链：申诉 = 请 AI 带用户理由重判；判分属软判断层 → 重判结果**直接生效**（无 proposal），correction event 留痕，FSRS 从事件重投影 | 用户（2026-06-10） |
| D16 | quiz（组卷/题源搜索/单题起草/题解生成）保持独立包，不并入 practice：它是 practice 与 copilot 共同消费的「出题」域，并入会让最大的 practice 包失衡 | AI 技术裁量（spec §2.3 ⚖️ 行了结） |

## 1. 范围

**做**：practice 包成形（server 等价迁移 + 测试随迁）；内核「提议生命周期」契约首立 + variant_question / question_draft 两个 applier 离开 actions.ts；流编排器 + 卷架后端（新表 + 服务 + API）；申诉自动重判链；流 UI / 卷架 UI（design 流程）+ 复习页退役 + 到期队列 UI 删除。

**不做**（明确出 P2）：judges 注册表迁移（住 src/core/capability，属 subjects 旅程）；block_merge / image_candidate applier（ingestion 旅程，P3）；quiz 包迁移（独立排期）；投影引擎契约（FSRS 平移即可，rebuild 能力等真需要时立——第二实例原则）；Coach handler 本体迁移（属 P4 能动旅程，P2 只改它的**产出协议**）。

## 2. 概念设计

### 2.1 流编排器（stream composer）—— P2 唯一全新构件

**领域模型**：新表 `practice_stream_item`（practice 包 schema 切片）：

```
practice_stream_item
  id              text PK
  date            date          -- 流按天组织
  position        integer       -- 当日排序
  item_kind       text          -- 'question' | 'paper'
  ref_id          text          -- question.id 或 paper id（软引用，沿用项目惯例）
  source          text          -- 'decay'(FSRS 衰减) | 'variant'(错题变式) | 'new_check'(新学自测)
                                --  | 'paper'(打包卷) | 'on_demand'(点播插入)
  status          text          -- 'pending' | 'in_progress' | 'done' | 'skipped'
  reasoning       text          -- AI 排入理由（第一人称 provenance 的素材）
  added_by        text          -- 'composer_nightly' | 'composer_live' | 'copilot' | 'user'
  created_at / updated_at
```

为什么物化而不是纯派生：流要支持白天动态插拔（Copilot 软判断改流、点播插入、做完推进），且用户中途离开回来流必须还在原状——这是「AI 维护的日程」，不是「查询结果」。与不变量不冲突：**作答事实仍只写 event**，stream_item 只是日程载体（类似现有 paper.plan），status 由作答事件驱动推进。

**编排服务**（纯函数核心 + 薄 IO 壳）：

```
composeDailyStream(inputs) -> StreamPlan
  inputs：FSRS 到期投影（现 due-list 逻辑内化为此输入）、错题与变体轮换（variant-rotation）、
          新学知识点待检清单（learning_item 路径上未检验的知识点）、目标偏置（goal scope 软排序）、
          当日已有卷（导入/点播待做）
  约束：日容量上限（warning 水位 + 硬顶，沿用护栏两层语义）、跨学科 round-robin（沿用 due-list 现行为）
```

触发：夜间 Coach 链产出当日流（替代「排卷」）；白天 `composer_live` 按作答事件增补（答错→可能插变式）。**due-list 的现有逻辑不删除，降级为 composer 的输入信号**（到期队列 UI 删除，引擎保留）。

### 2.2 卷架（paper shelf）

现有 paper 机制即「卷」本体，**不动存储**。改动只有三处：

1. **来源语义对齐**：卷的三种出生（AI 打包 / 点播 / 导入）；Coach 不再以「排卷」为日常产出（改排流），但保留打包能力（如周末小测卷塞进流）。
2. **卷架视图 API**：papers 列表按 状态（待做/在做/完成）× 来源 × 科目 查询 + 完成卷复盘读路径（已有 paper-detail 的今日/往日分区重组为卷架查询）。
3. **卷模式语义收编**：反馈缓冲（judge-now-show-later + visible_to_user 服务端门控）原样保留，明确为「卷」专属语义；流内散题 = 即时反馈。

### 2.3 申诉自动重判链（D15）

```
流内/卷内反馈卡「不服判」（带理由）
  → POST /api/review/appeal（升级现 stub：写 appeal_request event 照旧）
  → 入 pg-boss `rejudge` job（异步，遵循异步优先不变量）
  → judge 重跑：原题 + 原作答 + 原判分 + 用户理由（提示词明示「用户对此判定提出异议」）
  → 改判：correction event（supersede 原 judge event，既有机制）→ FSRS 状态按单一入口重写
  → 不改判：写维持原判 event（带新理由），同样留痕
  → 两种结果都推送工作台观察 + 流内反馈卡更新（SSE job_events 既有通道）
```

无新表、无 proposal（软判断层）；幂等键 = appeal_request event id。

### 2.4 内核「提议生命周期」契约首立

practice 是第一个有两个 applier 实例的包（variant_question、question_draft）→ 按第二实例原则，本契约 P2 立起：

- `src/kernel/proposals.ts`：`ProposalApplier` 接口（kind、Zod schema、apply(tx, proposal)、幂等键提取、过期规则）+ kind→applier 注册表（manifest 声明，组合根校验唯一性）。
- **actions.ts 改造为过渡 dispatcher**：`acceptAiProposal` 入口处先查注册表，命中走 applier（内核统一做行锁 + 幂等 + 事务），未注册 kind 走旧 switch——旧 case 随各旅程迁移逐个消失（P6 删空壳）。
- P2 拆迁：`variant_question`（case @606 与 @1994 两处语义合并核对）、`question_draft`（case @641）→ practice 包 `proposals/`。

### 2.5 等价迁移清单（server → practice 包）

`src/server/review/` 全量 → `src/capabilities/practice/server/`（测试先迁、git mv 保历史）：paper-detail(634) / due-list(615→composer 输入化) / paper-submit(600) / practice-read(356) / answer-draft(327) / variant-rotation(287) / effective-truth(176) / paper-sections(151) / rating-advisor(135) / fsrs(99) / paper-adaptation(71) + 全部测试（unit/db 按命名约定改名）。

**补遗（2026-06-10 勘察发现）**：`src/server/orchestrator/` 是混域目录，其中练习域的两个模块随 P2a 迁入——`review.ts`(639，会话编排) → `practice/server/review-session.ts`、`solve.ts`(426，解题会话) → `practice/server/solve-session.ts`（含各自测试）；`learning_intent.ts`/`teaching.ts`/`json-sanitize.ts` 留在原地等各自旅程。questions CRUD 路由（题库读写）暂不入 P2a，随 P2c 流编排器一并归位。

API 面壳化（route 留 app/api/ 一行挂载）：review/submit(532，**最厚，拆校验/判分/写库三段进包服务**) / sessions×5 / advice / appeal(升级) / weekly / plan / questions/[id]/solve 链(3 条)。

UI：`app/(app)/review/page.tsx`(1059) 与 `practice/[id]/page.tsx`(1023) 的退役/拆解见 §3 P2d。

## 3. 子阶段（每个独立 PR、独立可停）

| 子阶段 | 内容 | 系统状态 |
|---|---|---|
| **P2a 等价平移** | practice 包骨架 + §2.5 server/测试/API 壳化全量平移；行为零变化 | 与今天完全等价 |
| **P2b 提议契约** | kernel/proposals.ts + dispatcher 改造 + variant_question/question_draft applier 拆迁 | actions.ts 瘦 ~500 行，行为等价 |
| **P2c 流与卷架后端 + 申诉链** | practice_stream_item 表 + composer 服务 + 流 API + 卷架查询 API + Coach 产出协议切换（排流）+ rejudge job | 新 API 上线但旧 UI 照跑（复习页不知道流的存在） |
| **P2d 应然 UI** | 功能 handoff → claude design 视觉稿 → 流 UI/卷架 UI slice-by-slice 实现 → 你日用验收 → 复习页/到期队列 UI 退役（410/redirect 墓碑） | 应然练习面上线 |

P2d 的 design 交接点：P2c 合并后我产出**功能 handoff 文档**（界面清单 + 数据契约 + 交互行为，零风格规定），你带去 claude design；设计稿回来前 P2d 不动工，期间复习页继续服役。

## 4. 验收

- P2a/P2b：全 gate 绿 + 零残留 grep + 行为等价（测试随迁全绿 + 你日用无感）。
- P2c：composer 单测（纯函数核心可 unit）+ 流 API db 测试 + rejudge 链 E2E（appeal→改判→correction→FSRS 重投影断言）+ Coach 夜间链冒烟。
- P2d：视觉环（playwright 截图 + visual-verdict 对照设计稿）+ 你的日用验收窗口 + 退役墓碑生效。
- 每个子阶段 PR：双 bot review 收敛判据照旧。

## 5. 风险

| 风险 | 对策 |
|---|---|
| review/submit 厚 route 拆迁引入回归 | 测试先迁 + 532 行拆三段时逐段保持旧测试绿 |
| visible_to_user 门控（防作弊看答案）在迁移中被绕过 | paper-submit 测试显式覆盖该门控，迁移 PR 单独验证此项 |
| Coach 产出协议切换破坏夜间链 | P2c 用兼容双写过渡（同时产出流 + 旧 paper 引用），P2d 验收后停双写 |
| 流 UI 设计周期阻塞 | P2a-P2c 不依赖设计稿，先行合并；P2d 单独节奏 |
| actions.ts 双轨 dispatch 期的语义漂移 | dispatcher 改造带回归测试：每个已迁 kind 断言新旧路径不可同时命中 |
