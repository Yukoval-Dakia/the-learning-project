# YUK-1568 第 2 片：封闭数学比较核心与两端一致接线

2026-10-19。关联 YUK-1496（K1）、YUK-1559（C1）、YUK-1404（存量结构）。设计依据
[唯一设计](/Volumes/YukovalSBak/yukoval-projects/tlp-status/discussions/yuk1568-k1-answer-semantics-plan.md)
与 [统一设计 §2–§6](/Volumes/YukovalSBak/yukoval-projects/tlp-status/discussions/unified-question-grading-design.md)
（仓库外绝对路径；本片不重审设计）。第 1 片（PR #1812，main `8e692b015`）交付了
answer_shape/blank_order 声明、往返与中央再发布保护，并装了临时全挡闸。本片按已批准
顺序交付**第 2 片**：实际封闭数学比较 + 判分/准入同一解释器接线 + 仅对真实已支持
声明解除临时闸。不含生产端迁移（第 3 片）、不碰 40 题存量与 7 题（第 4 片/独立方案）。

## 本片交付了什么

### 1. 纯确定性共享核心（`src/core/schema/assessment/blank-answer-compare.ts` 新文件）

小接口 `compileDeclaredKey(shape, privateKey)` / `compareDeclaredBlank(shape, key,
rawResponse)`（设计 §3 拟议接口落地），`DECLARED_BLANK_COMPARE_VERSION =
'k1-math-v1.compare@1'`。内部规范值全部精确：

- **有理数**（BigInt 分数）：整数 / 有限十进制 / 有理分数全串消费；`5/2` 与 `2.5`
  同值，`1/3` ≠ `0.3333`（无 epsilon）。number 声明带 notation 门控（只声明
  decimal 时 `1/2` 不是合法输入）。
- **interval_set**：区间 `(a,b]`/`[a,b)`/`(-∞,b)`/`[a,+∞)`、`∪` 并集、绑定声明
  binding 的不等式（`x≥5/2 且 x≤7`、链式 `5/2<x≤7`、反向 `7≥x>5/2`）、set-builder
  `{x|…}`。开闭/无穷/空集（`∅`）精确；相接边界只在公共点确被覆盖时合并
  （`[1,2]∪(2,3)=[1,3)`，`(1,2)∪(2,3)` 保留缺点 {2} 不吞）。不等式子句为交集
  语义；并集答案用 interval 记号表达（封闭语法，声明 notation 管辖）。
- **binding 匹配逐字**：`M-m` 只匹配 `M-m`（去空白后整段相等），`m-M`/`M` 不匹配
  （不同量 → 不按声明可解析 → undecidable），绝不互换字母。
- **point**：有序坐标 tuple，坐标数必须等于声明的 axes 数；交换坐标是不同对象。
- **affine_line**：两侧线性表达式（隐式系数 `2x`、`x/2`、`2*x`、分数系数 `3/2x`
  按贪婪词法确定为 (3/2)·x）相减；非线性/除变量/未知变量/`0=0` 拒绝；仅**非零
  整体比例**等价（首 nonzero 系数归一）。
- **finite_set**：roster `{…}`（外层无序、必须列全、成员重复拒绝、`∅`/`{}` 空集
  合法）；成员按 item kind 用各自语法解析。set_builder 对 finite_set **本片未实现**
  → 声明即"未支持"，闸保持关闭。
- **复杂度边界**：输入 ≤480 字符、并集/子句 ≤24、集合成员 ≤48、直线项 ≤24、
  point axes ≤8；超限 → undecidable（明确 reason），绝不截断后比较。
- **单位**：number + 私有 numeric key 复用冻结容差/单位语义（mathjs
  parseUnit/equalBase/toNumber + withinTolerance 同式镜像，无新增宽容）；
  `expected_unit` 必须与声明单位同名同义（缺项/冲突 → 编译失败，不猜）。裸数仅
  `accepts_bare_number: true` 时按声明单位解释，否则 incorrect（漏单位=错，与
  既有 numeric 行为一致）。number + text key + 声明单位 → 确定性冲突（文本别名
  无法承载冻结单位语义）。区间/集合成员**不做容差配对**（非传递容差不进集合）。
  作答中的单位上标写法（`m²`/`m³`）属旧支持语义：折叠字符只保护数值词法区
  （`3² m`→`32 m` 类仍拒绝），单位 token 已开始后的折叠字符交给原 mathjs
  解析（R2 分流，见下）。

错误边界（设计 §3 表格落地）：作答解析失败/歧义/超限 → `undecidable`（判分侧
pending，绝不伪零分）；完整解析但不相等（错值/错端点/缺或多成员/换坐标/开闭不同）
→ `incorrect`，仍由原 rule 给分；键与声明确定性冲突 → `undecidable
(declared_key_invalid)`。

### 2. 同一解释器接到全部现役消费者

| 消费者 | 接线 |
|---|---|
| 实际判分 | `evaluation.ts` 把主槽位冻结的 answer_shape 随比较器分发传入；`grade.ts gradeBlankExactUnit(unit, entry, declaredShape?)` 声明路径全部委托 `compareDeclaredBlank`。无声明 → 旧 normalizeBlankText/numeric 路径逐字不变 |
| 准入双解 | `solve.ts keysAgree(a, b, normalization, shape?)`：声明槽 A/B **全部别名**经同一 `compileDeclaredKey` 编译（别名数可不同，每个都必须是同一完整对象；绝不交集/并集刷通过）；铸键 = 双方已验证别名的并集（实际 grade 逐一接受）。跨 kind（numeric×text）仅限无声明单位的 number 形状 |
| seeded 作者键 | 作者键自身先过 `compileDeclaredKey`（别名不完整/互不一致/单位冲突 → verdict `conflict`，不铸键）；`authorKeyAccepts` 对模型键**每个别名**（不再只 `accepted[0]`）走实际 `gradeBlankExactUnit` 验证 |
| solver 载荷 | `solverUnits` 的 blank spec 增加公开 `answer_shape`（复用唯一 Zod 权威；不携带答案/端点/容差）；任务 prompt 说明各 value.kind 的作答纪律 |
| 校准 | 探针照旧经 `evaluateSubmissionCore`（同一实际 grade 路径）；`methodFingerprint`（admission）与编辑 probe 指纹（edit-question.ts）在声明槽携带 answer_shape + `DECLARED_BLANK_COMPARE_VERSION` + slot 绑定 —— 声明/版本/单位语义变化即新指纹；无声明单元指纹字节不变，旧校准不受影响、不回填 |
| 探针纪律 | 声明槽：casefold 探针跳过（数学语法区分大小写，如实记录 skipped）；typical_wrong 先经同一比较核心分诊（读不出 → skip，不能断言计 0；相等 → 探针照发并如实失败暴露分歧）；不再合成 `${reference}x` 扰动（对声明语法是 unparseable，会制造假校准失败） |
| crosscheck | 复用声明与冻结 key 描述（describeKey 列完整别名），双盲独立性/参考权威不变 |

### 3. 仅真实已支持声明解除 1812 临时闸

共享判定（同一模块，闸门不各写一份）：

- `declaredShapeSupport(raw)`：schema 合法 + 全部 notation 已实现（IMPLEMENTED_
  NOTATIONS）+ 静态边界内。finite_set 的 set_builder 本片未实现 → 未支持。
- `declaredShapesAllSupported(rawSpec)`：裸行 JSON 宽松扫描（未知版本也算已声明
  并判未支持）→ enqueue / job maySend 付费闸。
- `declaredBlankGradeReadiness(spec, basis, partIds?)`：发出范围内每个已声明槽必须
  被支持、被 blank_key unit 读取、私有键可完整编译 → serving / admitted 发布闸。

| 闸 | 第 1 片行为 | 本片行为 |
|---|---|---|
| draft judgeable（draft-contract.ts） | 声明即 `judgeable_today=false` | 仅未支持声明扣留（`declared_answer_shape_unsupported:<reason>`）；已支持按常规规则 |
| publisher admitted（assessment-publication.ts） | 声明 + admitted 一律拒绝 | 声明 + admitted 时跑 `declaredBlankGradeReadiness`：任一槽未支持/无 blank_key unit/键编译失败仍拒绝（verify promote、校准回写同样过闸） |
| serving（serving-admission.ts） | 发出范围声明即拒发 | readiness 判定：就绪可出，任一缺项仍 `unsupported_deterministic_input` 拒发 |
| enqueue（enqueue.ts） | 声明即 skip 不入队 | `declaredShapesAllSupported`：未支持/坏声明仍 skip；支持则入队进双解 |
| job maySend（question_admission_run.ts） | 声明即关闸 | 同上判定；既有 receipt 恢复仍在 maySend 之前，unknown 不重放，paid identity/void 协议未动 |
| run-admission 预检（新增纵深） | 无 | 付费 solve 前把未支持声明的 blank 单元标 withheld（覆盖 submit_question 直接调用与手工 re-dispatch） |

保持不变：legacy `publishQuestionGroupFromRow` 中央保护（typed 声明保全，第 3 片
才逐 caller 迁移）；free/AI 方法不借此放行；数值/部分分 unknown/旧生命周期原样；
`format=math`、学科、题面公式仍不构成声明。

## 验证记录

### 早期临时脚本（2026-10-19，已停止，证据保留）

- 合入首版（06686a980）前，作者在仓库外 /tmp 写过两个临时脚本并对比较器
  公开入口实跑：一个 43 项**带断言/期望逐项比较**的检查套件（其中 7 项在首跑
  抓到真实的分数除法 bug 后修复转绿），一个 6 项 evaluateSubmissionCore 观察
  脚本（只打印实际结果，无机器断言，判读为符合预期）。**这些脚本未经
  owner 批准，违反“禁止未批准测试代码（含仓库外）”规则，现已停止创建与
  运行**；脚本与原始输出（含 RED 首跑）未删改，仅作审查证据，**不构成验收
  依据**。6 项 e2e 用的是合成 revision，不足 7 题真实入口。
- 独立 Codex R1（pr1815-implementation-review-r1-codex.md）为纯源码静态审，
  未执行上述脚本。

### 固定提交 06686a980 的检查（父会 2026-10-19 复核）

- typecheck / lint / lint:ratchet / build 均 exit 0（父会固定该 head 复核）。
- 作者本机早期 lint 记录另立如下，不与上面混淆：`pnpm lint` exit 1，
  9 个 error 全部位于本片未触及文件（agency/scripts/copilot），经 `git stash`
  在同 base main 上复跑确认与 main 相同的 9 个 pre-existing error；触及文件
  `biome check` 单独跑 0 error 0 warning。
- audits（exit 0）：schema、capability-boundaries、question-writers、api-client、
  api-client-usage、api-contracts、architecture-deepening、structured-judge、
  tool-params、draft-status、task-census。api-client 无漂移 →
  `api-schema.generated.ts` 本片无需再生成（HTTP 面未变）。
- `pnpm build` exit 0（server/worker/migrate bundle；compare 模块 mathjs 仅异步
  动态 import，与既有 grade.ts 同边，无新静态依赖）。

## R1 修复记录（同 PR 第二 commit，仅 blank-answer-compare.ts + 本文档）

独立 Codex R1 判 REQUEST_CHANGES（3 P1），父逐行核实成立，已修：

- **P1-1 同起点并集丢闭端**：`(0,1)∪[0,2)` 被误判为 `(0,2)`。修复为并集
  语义正确合并——同下端点闭性取两侧之或（真实并集 `[0,2)`）；prev 覆盖到
  +∞ 的早 continue 分支同样先合并同下端点闭性（`(0,+∞)∪[0,+∞)=[0,+∞)`）；
  相邻双开区间缺点保留不变。修的是整条合并路径，非例证特判。
- **P1-2 缺失项间分隔符 + NFKC 上标语义改写**：`y=x²` 经 NFKC 变 `y=x2` 后
  被暗作 `x+2`。两层修复：① 规范化入口（准入编译与作答共用）在 NFKC 之前
  显式拒绝上标/下标/分数字符（²³¹、ⁿ 类、₀ 类、¼½¾ 类、⁄），返回
  `superscript_subscript_or_vulgar_fraction_not_supported`，绝不丢语义后
  继续猜；② 直线表达式首项之后必须有显式 +/- 分隔，否则
  `line_term_separator_missing` 拒绝，不再把相邻 token 默认相加。当时记录为
  "既有单位换算（mathjs lane）未改"——指 convertUnitTo 函数体未改；R2 核实
  入口整串 guard 先于单位换算运行，已使声明单位作答（`3 m²` 类）回归为
  pending，该回归在下方 R2 修复中分流处理。
- **P1-3 连续除法右结合**：`x/2/3` 被词法吞成 `x÷(2/3)=3x/2`。修复：词法层
  给分数 token 打 compound 标记；除法上下文（变量后的除数）遇 compound
  分数即拒绝 `line_consecutive_division_not_supported`（源串必为连续除法，
  结合性有歧义，不允许任何一种结合）；无歧义的独立分数系数（`3/2x`）与
  单次 `x/2` 保留。

修复后语法边界/失败 reason（如实）：上标/下标/分数字符一律拒绝；直线项间
必须 +/- 分隔（`x2`/`2x3y` 类拒）；连续除法（`x/2/3`、`x/3/2` 类）拒绝；
`x/2*3` 类除法后接乘的链形不在封闭语法内同样拒绝。以上均 undecidable/invalid
带具体 reason，准入编译与作答两入口同语义。未扩成通用表达式系统。

## R2 修复记录（同 PR 第三 commit，仅 blank-answer-compare.ts + 本文档）

独立 Codex R2 判 REQUEST_CHANGES（原 P1-1..P1-3 全部 CLOSED，新 P1：1），父
核实依赖源码成立，本轮已修：

- **R2-P1 单位作答回归**：R1 P1-2 的整串上标拒绝在 `compareDeclaredBlank` 作答
  入口先于 `convertUnitTo` 运行，使旧支持的声明单位作答变为 pending。触发：
  `version=k1-math-v1`、`value.kind=number`、`unit.unit=m2`、
  `accepts_bare_number=false`、私有 numeric key `expected=3`/absolute tol
  `0.01`/`expected_unit=m2`；作答 `3 m²` 旧路径经 convertUnitTo 内 NFKC 得
  `3 m2`，mathjs Unit.parse 命中内建 m2（SURFACE）判 correct；R1 后被整串
  guard 拦为 undecidable → pending。体积 `m³` 同理（内建 m3=VOLUME）。
- **修法（最小分流，非绕过 guard）**：声明 `expected_unit` 的 number_tolerance
  lane 改用 `declaredUnitResponseCorruptsValue` 作折叠字符检查——逐折叠字符
  判定其之前的全部 raw 前缀经 NFKC 后是否整段属数值词法区字符类
  `[+-0-9.eE\s]`（mathjs 从串首读 `[±][0-9.eE]` 数值区）。落在数值区内或紧
  邻其后的折叠字符会把产物并入 mathjs 读到的值（`3² m`→`32 m`、
  `3e² m`→`3e2 m`、`²m`→`2 m`、`３² m`→`32 m`、`3⁄4`→`3/4`），仍按同一
  `superscript_subscript_or_vulgar_fraction_not_supported` 拒绝；单位 token
  已开始（前缀含字母/括号等非数值区字符）后的折叠字符只落在单位部分，交给
  convertUnitTo/mathjs 原样决定——`m²`→`m2` 正是旧支持写法。
- **保留不变**：R1 P1-1 并集闭性、P1-2 整串 guard 对全部非单位 lane（无单位
  number 精确/容差路径、interval_set、point、affine_line、finite_set 及准入
  编译入口）与项间 +/- 要求、P1-3 连续除法拒绝全部原样；`3² m` 类数值改写
  在带单位作答中同样不得分（undecidable）；accepts_bare_number=false 时裸数
  仍 incorrect（missing_unit）；量纲不符仍 incorrect；mathjs 不认识的写法仍
  unparseable → undecidable；容差与 expected_unit 编译约束未动；未声明旧
  路径不动；grade/admission 共享同一入口。未引入通用表达式系统、注册表或
  单位特判表。

本机检查（本修复 commit，SWE-2 high 如实记录）：`pnpm exec biome check` 触及
文件 exit 0；`pnpm typecheck` exit 0；`pnpm lint` exit 0（179 项 warning 全部
位于本片未触及文件，触及文件 0 hit）；`pnpm build` exit 0（web + server/
worker/migrate bundle）。本轮未编写/运行任何测试、断言脚本、inline 探针
或旧 /tmp 脚本；未访问 DB/容器/provider/付费；真实题验收仍按"第二片部署后
在副本执行"的既定窗口，不因本修复提前或推迟。

## NOT_RUN / 边界

- 本轮（R2 修复）未编写/运行任何测试与断言脚本（owner 规则；首版早期临时
  脚本已停、证据保留，见上"早期临时脚本"节）。本机不跑 full `pnpm test`，
  完整 gate 由 exact-head CI 执行。
- 未访问 DB/容器/TEST provider/付费调用；40 存量题与 7 题未动（冻结证据确认
  7 题均为旧单 text 槽，本片不拆题）。
- 真实题验收时点（协调线最新决定）：**第二片部署后于副本执行**，不等第
  4 片；具体窗口/资源/存量付费仍待对应审批，尚未获批。本片不以合成例冒充
  真实题验收。
- finite_set 的 set_builder 记号、不等式**析取**（`或`）未实现 —— 声明即未支持，
  闸保持关闭（封闭语法，未来片扩展须新比较版本号）。
- 生产端四入口（sourcing/quiz_gen/录入/编辑提示）迁移是第 3 片；本片不碰
  provider 选型/路由/预算。
- 合入后新声明题从“只存草稿/暂扣”变为“支持声明可全链准入+判分+发题”，但
  真实生产证据以后续片与副本验收为准。
