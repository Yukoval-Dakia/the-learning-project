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

## 机械验证记录（本机，2026-10-19）

- `pnpm typecheck` exit 0（tsc noEmit ×2）。
- `pnpm lint` exit 1 —— 9 个 error 全部位于本片未触及文件（agency/scripts/copilot），
  经 `git stash` 在同 base main 上复跑确认**与 main 完全相同的 9 个 pre-existing
  error**；本片 14 个触及文件 `biome check` 单独跑 0 error 0 warning。
- `pnpm build` exit 0（server/worker/migrate bundle；compare 模块 mathjs 仅异步
  动态 import，与既有 grade.ts 同边，无新静态依赖）。
- audits（exit 0）：schema、capability-boundaries、question-writers、api-client、
  api-client-usage、api-contracts、architecture-deepening、structured-judge、
  tool-params、draft-status、task-census。api-client 无漂移 →
  `api-schema.generated.ts` 本片无需再生成（HTTP 面未变）。
- 比较核心公开入口实跑（tsx 一次性探针脚本，仓库外 /tmp，未入库）：43 项
  全过，覆盖验收语义样本 —— u83 定义域并集/闭端点拒/减区间、ocfk `a≤0`（含
  `a<0` 区分）、nl7 `(5/2,7]`≡`2.5<x≤7`、`[5/2,7]` 拒、ft0 `8/27≤M-m<2`≡
  `[8/27,2)`、`0.2963`≠`8/27`、`m-M` 不可解析、iqsi 三直线集合（重排/比例/
  移项/`y=` 形等价；缺/多成员、符号错、`0=0` 拒）、p81 两点（外层无序、换坐标/
  缺点/重复拒）、`1/3`≠`0.3333`、容差与单位（`3 m` 对、裸 `3` 缺单位错、
  `0.03m`→cm 对、`3 kg` 量纲错）、相接开区间缺点保留。**此为公开入口机械验证，
  不是真实题验收**（见 NOT_RUN）。

## NOT_RUN / 边界

- 未运行任何测试（owner 规则：测试另批文字方案；本机不跑 full `pnpm test`）。
- 未访问 DB/容器/TEST provider/付费调用；40 存量题与 7 题未动（冻结证据确认 7 题
  均为旧单 text 槽，本片不拆题）。
- 真实入口（edit_question → compose → submit → evaluateSubmissionCore）对已声明
  副本的验收属第 4 片独立批准窗口；本片不以合成例冒充真实题验收。
- finite_set 的 set_builder 记号、不等式**析取**（`或`）未实现 —— 声明即未支持，
  闸保持关闭（封闭语法，未来片扩展须新比较版本号）。
- 生产端四入口（sourcing/quiz_gen/录入/编辑提示）迁移是第 3 片；本片不碰
  provider 选型/路由/预算。
- 合入后新声明题从"只存草稿/暂扣"变为"支持声明可全链准入+判分+发题"，但
  真实生产证据仍以第 3/4 片交付为准。
