# 红线挑战审查（2026-07-07）

> **命题**（owner 2026-07-06）：「本轮的主题是挑战红线。项目在构建过程中积累了很多的『红线』。我需要你追究其原因和合理性，试图挑战他们。」
>
> **方法**：ultracode workflow `wf_ac7fa76c-a9b`（46 agent / 4.10M tokens / 51min / 0 error / 833 tool calls）。
> 编成 = 16 簇盘点 + 补漏 sweep（报 8 取 6）→ 每簇挑战者（溯源→钢人→攻击→裁决；P2/P5/A5/A7 四重簇 fable xhigh，其余 Opus high）→ 非 KEEP 初裁触发 **fable xhigh 辩护人** → 裁决冲突触发 **fable xhigh 终裁人** → **fable 橡皮章审查员**（复核过软 KEEP + 横切矛盾）。
> 全部裁决书原文：workflow journal `~/.claude/projects/.../subagents/workflows/wf_ac7fa76c-a9b/journal.jsonl`。

## 0. 总格局

**22 簇：KEEP ×5 · KEEP-WITH-COST ×15 · REWRITE ×2 · RELAX/DROP ×0。**
挑战者初裁 12 个非 KEEP（REWRITE ×11 + RELAX ×1），辩护/终裁环用实读证据推翻其中 10 个——对抗环真实工作了，不是橡皮章（多个挑战者的承重证据被终裁实读击倒，见 §4 判例）。

**核心结论：红线条文本体几乎全部承重（多为血泪起源或已两次赢下与现实的对撞）；真正的病灶不在任何单条红线，而在体系层——成文跟不上现实、执行强度与爆炸半径倒挂、登记面单向棘轮增长。**（详见 §3 横切七条。）

## 1. 总裁决表

| # | 红线簇 | 起源 | 裁决链（初裁→辩护→终裁） | 终裁 |
|---|---|---|---|---|
| P1 | Scope Discipline / 最小充分解 | mixed（舶来+owner，后被 26 doc 实证承重） | KEEP-WITH-COST | **KWC** |
| P2 | Session Cockpit（PLAN.md 三件套） | mixed | REWRITE → 辩护维持 | **REWRITE** |
| P3 | UI design pre-flight | incident-born（route-vs-drawer / runner drift 两事故） | REWRITE → 辩护翻 KWC → 终裁 KWC | **KWC** |
| P4 | Linear 纪律簇 | mixed | KEEP-WITH-COST | **KWC** |
| P5 | Git 安全簇 + owner-merged 句 | mixed | REWRITE → 辩护 OWNER-DECIDE → 终裁 KWC（owner-merged 句单项维持已排队 owner 亲拍） | **KWC** |
| P6 | Audit gate 家族 | mixed | KEEP-WITH-COST | **KWC** |
| P7 | 杂项硬规则（umask/No Vercel/date/MCP） | mixed | REWRITE → 辩护翻 KEEP → 终裁 KEEP | **KEEP** |
| P8 | 方法论仪式（不删 pre-AI / 三腿 grounding / misconception 全套） | mixed（pre-AI 腿=双重血泪条款） | RELAX → 辩护翻 KWC → 终裁 KWC | **KWC** |
| P9 | 模型路由（subagent 默认 Opus / fable 稀缺） | mixed | REWRITE → 辩护翻 KWC → 终裁 KWC（挑战者 fatal claim 被证伪） | **KWC** |
| A1 | 七条产品红线（locked） | mixed | REWRITE → 辩护翻 KWC → 终裁 KWC（七句一字不改） | **KWC** |
| A2 | 三轴正交 | mixed | KEEP-WITH-COST | **KWC** |
| A3 | n=1 红线簇 | mixed | REWRITE → 辩护翻 KWC → 终裁 KWC（scoped 勘误） | **KWC** |
| A4 | Event-sourcing 咽喉 | mixed（PR #163 回滚实证） | KEEP-WITH-COST | **KWC** |
| A5 | Dark-ship / flag 纪律 | mixed | REWRITE → 辩护翻 KWC → 终裁 KWC（三句不动+corollary） | **KWC** |
| A6 | 防循环注入五防 | mixed | KEEP | **KEEP** |
| A7 | 结算层零能动性 + scout/evidence 纯度 | mixed（owner 亲拍） | REWRITE → 辩护翻 KWC → 终裁 KWC（条文一字不动） | **KWC** |
| X1 | agent 记忆 vs 产品事实双写禁令 | mixed | REWRITE → 辩护翻 KEEP → 终裁 KEEP | **KEEP** |
| X2 | 付费动作显式授权 gate | mixed | KEEP-WITH-COST | **KWC** |
| X3 | hint-first + 完整答案逃生口 | mixed（owner 反复亲拍） | KEEP | **KEEP** |
| X4 | 无死 fallback / typed refusal 不伪造中性值 | mixed | KEEP-WITH-COST | **KWC** |
| X5 | 未校准置信度 shadow-only | theory-born | KEEP | **KEEP** |
| X6 | 北极星/Coach additive-only「结构性保证」 | theory-born | REWRITE → 辩护维持 | **REWRITE** |

## 2. 两条存活的 REWRITE

### P2 — Cockpit：红线自身制造了它要防的看板腐败（fable 挑战 + fable 辩护双确认）

实证：PLAN.md 头部 21 行占全文 42%（49,447 / 116,922 字节），单行 13 长达 30,972 字符；「更新于」戳停在 2026-06-23；四栏活看板被追加式【更新】日志淹没（NEXT 栏还挂着已 MERGED 的 #607/#610）；「session start 必读」×膨胀 = 每 session 开局 ~33-47k token 税；条文点名的 handoff 文件 `.remember/remember.md` 实测 0 字节（死指针，真 handoff 在 now.md/recent.md/today-*.md）；「收尾必同步」在 commit 维度 14 天未执行（06-20→07-04 零 commit，一次补交 165 行）。

**修文案（保留全部实质，改三处）**：① CLAUDE.md:17 死指针 `.remember/remember.md` → `.remember/now.md`（近况 recent.md / 当日 today-*.done.md）；② Cockpit 定义句后加体积纪律子款：「**PLAN.md 是看板不是日志**：正文预算 ≤200 行、头部只留最新 1 条【更新】；超龄叙事段收尾滚存 `.remember/today-*.done.md` 或 docs/；四栏对齐 = 就地改写（删改过期条目，不得靠追加新段对冲旧矛盾）」；③ 收尾 checklist ① 改「四栏**就地改写**对齐 + 滚存超龄日志段 + **commit**（工作树里过夜的看板等于没有看板）」。配套一次性动作：现存 ~49KB 头部日志滚存归档。
⚠️ **执行前置**（critic 抓到的跨裁决依赖）：P5/P9/A5 三份 KEEP 裁决的证据锚点（standing-grant 队列 PLAN.md:15、模型路由修正段行 13、flag 登记）恰在待压缩的头部日志里——滚存归档必须**保内容原文**（进 today-*.done.md/docs），不可有损压缩。

### X6 — ADR-0025「结构性保证」已被 YUK-167 证伪 + 守卫测试 fixture 退化恒绿

ADR-0025:88 与红线断言「due 队列与 goal/Coach 零耦合，是**数据流结构性保证、非约定**」——但 YUK-167 已在 due 路由内引入 goal 软重排（`rerankOverdueByGoals`），结构性隔离已降级为 test-enforced order-only 纪律；ADR:102-106 守卫描述含「顺序逐字节一致」与刻意改顺序的既定行为直接矛盾。**更实质的缺陷**：ADR 称 `coach_daily.northstar.db.test.ts` 为「the load-bearing 守卫」，但其 fixture 所有 overdue item 全 goal-relevant → `others.length===0` 早退 → **重排路径从不触发、测试恒绿**；真守卫其实是 `due-soft-bias.db.test.ts`。
**修文案**：改写「结构性保证」段为「W9 core 零耦合；W10（YUK-167）起 due 路由 MAY 读 goal scope 软重排，set/counts/due_at/fsrs_state 不变，由 conservation + soft-bias 双 DB 测试守护」；守卫描述删「顺序」、指明 due-soft-bias 为重排路径真守卫；**northstar 测试 fixture 补非 goal-relevant overdue item 使重排路径可达**。核心四禁令（不抑制/不隐藏/不抢占额度/不改 due）措辞不动——仍真且被强制。

## 3. Critic（fable）横切七条——体系级病灶

1. **成文-现实分裂是全系统最高频失效模式**（≥8 簇独立踩中：P5 owner-merged 句、P9 CLAUDE.md:5、P1 反过度工程撤回、P6 audit 执行方式自述、A3 §3① vs 3PL 代码、A1 current-map:123、X6 ADR vs YUK-167、P2 全面腐败），但没有任何机制拥有「条文对齐义务」；讽刺的是专治此病的 `/audit-drift` skill 手动触发、本轮零人跑过——**治疗全系统头号病的药自己是条「建成不通电」dark lane（元层面违反 A5）**。
2. **执行强度与爆炸半径倒挂**：机器 gate（7 audit + 3 hook）密集守低爆炸半径的数据卫生；locked 的最高风险不变量（A1/A2/A4/A5/A7/P9）全是散文+人肉。「纯人肉执行」作为 challenge 在 20 簇里复现 ≥12 次——同一条 minor 复现 12 次就不是 minor，是体系架构本身。
3. **仲裁判例互相矛盾**：「owner 指令能否住 agent 可写载体」三案三答（P5 拒 PLAN.md 当权限真相源=「权限洗钱通道」；P9 接受 PLAN.md+ctx_memory 当路由权威；X1 容忍 AGENTS.md SPIKE 段住 owner 级不变量）。
4. **PLAN.md 单点悖论**：P2 裁 REWRITE 的同时 P5/P9/A5 三份 KEEP 的证据锚点承重在其待压缩头部——无跨裁决协调（已折入 §2 P2 执行前置）。
5. **红线体系是单向棘轮**：本轮 0 RETIRE，且几乎每份仲裁的救济都是净增制品（audit:flags、audit:fold-writes、step9 断言、勘误、注记……）；每个新登记面自带维护义务，而 P6 已实证 allowlist 解除机制 98% 失灵（63/64 条 kind:manual 规避机器可检通道）——**体系在用「再加一个登记面」治疗「登记面太多」**。
6. **「建成不通电」一个失效模式被 ≥5 条红线从相互冲突方向设防**（A5 强制暗建 / P1 禁止先建 / X4 记录成本 / X5 允许无限期停暗 / A2 卡集成），无任何一条拥有「何时允许 build-ahead-of-consumer」的全局判据，边界每次靠 owner 现场判断。
7. **本轮 workflow 自身正在生产它审查的失效模式**：多份仲裁明文拒执行 P4 capture gate 把 ≥8 条 follow-up 递延给 parent；裁决书里的行号锚点落笔即漂移。（parent = 本 session：follow-up 已全量收进本报告 §5 + PLAN.md，未静默丢失。）

Critic 另抓 4 个过软 KEEP：**P6**（更深机制失效=allowlist kind:manual 98% 规避，机器可检解除通道形同虚设）；**X2**（23 个夜间 cron 组成自主付费 AI 链，research_meeting_nightly 每晚最多 ~9 次 Opus 走 anthropic-sub OAuth 烧订阅额度，cap≠授权、各 job cap 互不知晓、无聚合预算）；**P4**（closeout hook 因工作树恒 dirty 恒真触发=警报疲劳，「声明产出」不能当合规证据）；**P1**（「反过度工程协议已撤回→两案并呈」已固化为 ≥4 份 spec 继承红线，与 CLAUDE.md「smallest sufficient」构成 P5 同款成文/实践分裂，却连待拍队列都没有）。

## 4. 判例亮点（挑战被终裁实读击倒的案例，防复查复挑）

- **P9**：挑战者 fatal claim「PLAN.md 07-03 路由修正段不存在」被证伪——段落逐字存在于行 13（22,293 字符单行巨段第 ~12.7k 字符处）；其 `grep -c` 数的是**行数**不是**出现次数**，在单行巨段上方法论失效。
- **P7**：「No Vercel 句前提已死」被 git 考古击倒——054837cd 时本仓库正是 Next.js（standalone build），句意从诞生起就指**外部**项目经验；399c8690（YUK-321 M5 终局 drift 审计）对该行逐字重审保留并有意新增括注——是 3 周前刚过审的现役措辞。
- **A3**：挑战者最重成本项「fixed-anchor 写入面 ABSENT」被代码直接证伪（`src/server/mastery/fixed-an…` 已建）；1PL vs 3PL 的真相是「永不**拟合**跨考生方差分量」——YUK-436 的 c=1/k 来自题型结构（choices 数）非拟合，合法。
- **P8**：「不删 pre-AI features 无事故支撑」被 doc 考古击倒——2026-06-18 vision doc 实录 owner **两次纠偏**（「删 pre-AI 器官是 novelty-purism 误判」）+ abandoned-directions 正式墓碑，条文次日落地；挑战者只搜 commit 没搜 doc。且其收窄改写会把 composeDailyStream 类非题库 pre-AI 路径踢出保护圈——恰是反噬。
- **A1③**：「event 唯一真源是字面虚假」定性错误——锁的是**规范**非**描述**，且锁定文档自己登记了缺口（current-map:107 ⏳）；红线两次赢下与现实的对撞（ADR-0044 owner 拍 651k-token 改造让代码合规而非放宽红线；YUK-561 owner 否决「退 A-class 接受单向写面」）。
- **A7**：「零能动性字面过强」是断章——原文是「账本**直写**零能动性」，第四句就是持笔权表述；quiz_verify/rejudge/reconcile 三个「相悖案例」全部是「LLM verdict 经 schema 验证入口进确定性 TS 单写者」的合法形态。
- **X1**：「威胁路径已空（hosted mem0 未接线）」不成立——产品侧写路径禁令不依赖 hosted 层；ADR-0017 Errata 记录 single-owner 写路径曾被 PR #163 实际违反、代价 PR #165 七修——「散文不承重」被历史否证。

## 5. Owner 拍板菜单（按优先级；全部未开 Linear 单，待拍板后逐项开）

**批①（已有排队/成文冲突，最急）**
1. P5 owner-merged 句：改 CLAUDE.md Code Review Workflow 或保持人工合——已在队列（PLAN.md:15），本轮终裁维持该队列、不代拍。
2. P1 Engineering Approach 分层措辞（critic 主张 P5 同款待遇）：把「smallest sufficient」拆为「未授权基建→直接砍」vs「判断型取舍 fork→两案并呈 owner」两层，与 ≥4 份 spec 已继承的「反过度工程协议已撤回」对齐。
3. P9 CLAUDE.md:5 刷新为现行三档（subagent 默认 Opus / fable 顶档稀缺 / Sonnet 轻量机械）+ PLAN.md 行 13 stale 段加内联指针。

**批②（两条 REWRITE 的执行授权）**
4. P2 cockpit 三处修文 + PLAN.md 头部滚存归档（保原文、防 P5/P9/A5 锚点蒸发）。
5. X6 ADR-0025 改写 + northstar 守卫测试 fixture 退化修复（唯一接近「真 bug」项：守卫恒绿）。

**批③（工程单候选，均 report-only/additive，不改红线）**
6. `audit:fold-writes`（A4）：fold-owned 表 raw UPDATE 静态扫——补最高危不变量的机器兜底（横切 #2 的第一刀）。
7. `audit:flags`（A5）：全仓 *_ENABLED（env+const 双轨）↔ 翻转单对账 + 四变体字面量统一；A5 条文追加 corollary「flag 钉在 act/消费点，OFF 期间采集面照常 live；整能力 go-live 门须当刻登记翻转单」。
8. step9 断言扩展（A7）：kc_typed_state/learner_axis_state 单写者机器枚举 + ADR-0025 ND-5 三义消歧注记。
9. P6：修 CLAUDE.md:83 stale 对比句（audit:schema/partition 实际已在 ci-gate.yml 远端硬 gate）；拆 49 条 2026-07-31 同日到期悬崖（错峰或收敛 table-level 豁免）；正视 allowlist kind:manual 98% 规避问题。
10. X2：ADR-0002 成本叙事更新（主抽取已是自动付费 VLM）+ 夜链聚合预算/订阅额度侵蚀问题（23 cron、cap≠授权）。
11. A2：§0 表加「执行状态」列（只有 C3 是代码强制）+ 诚实标注 C2 长链污染路径 not covered、mem0 wiring（H5）前置曝光底线 invariant。
12. A3：cold-start doc §3① scoped 勘误（「拟合 vs 结构常量」判据），deadline = THETA_GRID_ENABLED 翻转前。
13. 体系级（横切 #1/#5）：给「成文对齐义务」找一个 owner——最便宜路径是把已建成的 `/audit-drift` 通电（排期跑一次），否则它继续元层面违反 A5。

**明确不动**：A1 七句（locked 不变）、A5 三句、A7 条文、A6 五防、P3 pre-flight 条文、P7 四条、X1/X3/X5 全文。

## 6. 覆盖披露

- 补漏 sweep 报 8 条、cap 取 6 进管线；**2 条未审**（下轮可补）：`kg-mesh-no-tree-expressed-edge`（mesh 不存 tree 已表达的边）、`credit-decay-weight-vs-encompassing-weight-separation`（credit 衰减只用 encompassing_weight，weight 钉死 confidence-only）。
- 覆盖判定为「独立红线」但与 16 簇邻接的：X1-X6 均已独立全审。
- portfolio §5 红线挑战组 3 条（knowledge_edge 升 A / applied_in 通电 / 自动 dismiss）**未重审**——已有完整对抗记录在案待 owner 拍板，本轮只收录不重造。
- 裁决书内全部 file:line 锚点为落笔时点快照（2026-07-06/07），随 main 前进会漂移（critic 横切 #7 自指）。
