# assessment-publication 组契约解析拆分 — 交付说明（YUK-1572）

状态：已实施；本地门已实跑（父完成一次 frozen install 后，heavy.sh 串行
typecheck/lint/build/两 audit 全 rc=0；过程见「验证」）。服务"证明有效"阶段
的 kernel 读职责归位；`records/` 同层拆分，无跨边界新边。

基座 `ce74a7733f93044f55c0b00d056ae3c8d137f1fc`（= 拉取时 origin/main，
fixed main，未带父旧提交；本 worktree T3 预建分支落后 36 提交/带父 docs 提交，
已弃用，新分支 `arch/yuk-1572-assessment-publication-read` 自 origin/main 切出）。

## 变更内容

- 新增 `src/kernel/records/assessment-group-contract.ts`（141 行）：组权威契约
  解析模块，导出 `ResolvedGroupContract` 与 `resolveGroupContract(db, root,
  liveParts)`。承载「stored state → NormalizedContract」全部知识：declared
  冻结四层路径（YUK-1568 中央保护：lifecycle 指针未锁读 → revision 四层读 →
  answer_shape/blank_order 声明检测 → publishedContractSeal 解析 → 原样返回
  库内契约，坏声明 fail-loud）与 legacy 行归一路径（figure 实内容 digest
  核验 → normalizeQuestionGroupToContract）。
- `src/kernel/records/assessment-publication.ts`：1562 → 1464 行。仅三处
  hunk：`'@/core/schema/assessment'` import 删 3 个仅服务被搬块的符号
  （describeAnswerShape / findAnswerShapeDeclarations /
  findBlankOrderDeclarations）；`'./assessment-normalization'` import 删
  `normalizeQuestionGroupToContract` 并新增同层
  `./assessment-group-contract` 的 `resolveGroupContract`；加载口内
  declared 块 + figure digest + normalize 调用（原 1157–1257）替换为
  `resolveGroupContract` 单调用 + 原样返回快照。
- 入口 `loadQuestionGroupContractSnapshot` 与 `QuestionGroupContractSnapshot`
  **原位保留，签名/返回形状/错误文本逐字节不变**，且仍是实体函数：持有
  root FOR UPDATE 锁策略（P1-1 惯例与 lockRoot 契约）、组根存在性与
  not-found 错误、parts 列查询、tombstone→live 过滤规则、快照装配。
  非 re-export、非转发壳；消费者零改动。
- 保护段逐字节未动：publishQuestionGroup（672 起）、FromRow（1296 起）、
  appendAdmissionVerificationRecord/insertAdmissionVerification、
  archive/restore/seal/outbox 事务 —— `git diff` 仅含上述三个 hunk。

## 拆分边界为何成立（五标准对账）

- **责任**：模块 = 组契约解析（两条互斥解释器 + 回退选择）；入口 = 组行快照
  （锁序、成员边界、返回形状）。写协议（publish/CAS/lifecycle/verification）
  与读模型分离落在原文件内既有节界上。
- **接口**：`resolveGroupContract(db, root, liveParts) → {declaredRevisionId,
  contract}` —— 调用方无需知道 declared 检测、seal 解析、声明回退规则、
  figure digest 来源与 normalizer 调用形态。
- **隐藏知识**：lifecycle 指针列、revision 四层列、声明探测谓词、fail-loud
  错误构造、source_asset  digest 装配、NormalizableQuestionRow 适配，全部
  私有化；`findAnswerShapeDeclarations` 等三个谓词随之迁出（父文件零残留）。
- **修改局部性**：契约解释语义演进（新声明类型、seal 格式、digest 来源）
  只触新模块；组成员边界/锁序/快照形状演进只触父文件加载口；写协议演进
  不触读模型。
- **行为证据**：以语句级对账 + 语义等价点举证——移除块的每条语句在新模块
  均有逐字对应（唯一格式差：presentation spread 行按 100 列折行）；控制流
  有重塑，如实声明：原 `declaredRevisionId`/`frozenContract` 临时赋值 + 末尾
  `if (frozenContract != null)` 分支改为 `resolveGroupContract` 内直接
  `return { declaredRevisionId, contract }`，入口再以解构字段组装同形快照。
  等价以相同查询顺序（root→parts→lifecycle→[declared: revision 早退、无
  asset 读]|[legacy: asset→normalize]）、相同触发条件、相同返回字段值与
  错误类型/错误文本（含 `loadQuestionGroupContractSnapshot:` 前缀）证明；
  调用栈边界如实变化 —— 抛错现经 `resolveGroupContract` async 帧，不声称
  栈不变。每次调用仍返回全新对象字面量。

## 两个真实变化场景

拆分前两处逻辑本就在同一文件，**不声称减少编辑文件数**；真实收益是
快照装载职责与契约解释职责分离：

1. **快照装载/版本回退演进**（如新增声明种类或 seal 版本）：改动落在
   `assessment-group-contract.ts`，与行快照职责物理隔离；调用方
   （source_verify、publisher、FromRow）少知「契约如何物化」。
2. **publication 写协议演进**（CAS/admission/lifecycle 变化）：改父文件
   publish/lifecycle 节，不触读模型与契约解析知识。

## 消费者与闭包

- `loadQuestionGroupContractSnapshot` 消费者全部经父文件原入口：
  `capabilities/practice/jobs/source_verify.ts`（C1 守卫，锁后读）、
  `server/questions/publisher.ts`（FromRow seam）、
  `source_verify.test.ts`（lockRoot:false，测试未动）、同文件
  `publishQuestionGroupFromRow`（declared 冲突判定的 declaredRevisionId
  字段保留）。`question_admission_run.loadDefinition` 是 docstring 明示的
  逐字段等价既有实现，不在本 lane 写权，未动（观察：其无 declared 路径，
  差异归既有事实，交父知悉）。
- `resolveGroupContract` 唯一消费者 = `loadQuestionGroupContractSnapshot`；
  无 registry/barrel/shim 新增；kernel 依赖方向不变（@/core、@/db、
  drizzle-orm、./assessment-normalization）。

## 实测指标（本 head，非收益声明）

- `assessment-publication.ts`：1562 → 1464 物理行（-98）。
- 新增 `assessment-group-contract.ts`：143 行。合计 +45 行（模块头/接口/
  docstring/import 开销），数字本身不是收益。
- audit 实测（本 head，`audit:capability-boundaries` stdout）：>1500 文件
  **14（基 15）**；capability→server=403、server→capability-deep=0、
  cross-capability-value=37、新依赖边=0、非平凡 SCC=1（基 1）。
  `audit:architecture-deepening`：pass-through sites 1088（**+0 new**）、
  依赖总量 403/0/37 < 531/70/62、SCC 目录 21 边/7 public-read/14 command。
  收缩按 source-size 棘轮无需 sourceSizeRecords 登记；新文件低于 1000
  登记阈值。以上实测差值供父登记参考，本 lane 未改
  baseline/audit/schema/CI/package/lock。

## 验证

实跑（父 frozen install 后，heavy.sh 串行；raw stdout/stderr + argv/UTC/
真实 rc 封存于下述目录）：

- `pnpm typecheck`：rc=0（21:43:27–35Z，最终字节复跑）。
- `pnpm lint`：rc=0（21:43:55–57Z，180 条存量 warning、0 error）。如实
  过程：初跑（21:41）rc=1，唯一 error 是**本 lane 新文件的格式诊断**
  （spread 行折行），`biome check --write` 修复后全量复跑清零；修复使该行
  与 base 原文逐字一致。触及两文件 scoped `biome check` rc=0。
- `pnpm build`：rc=0（21:42:30–40Z）。
- `pnpm audit:capability-boundaries`：rc=0（实测数见上节）。
- `pnpm audit:architecture-deepening`：rc=0（pass-through 1088 +0）。
- 语句级搬移对账脚本（`reconcile.py`）：PASS（语义与边界见「行为证据」）。
- `git diff` 审查：恰 3 源码 hunk，保护段零命中。PASS。

NOT_RUN：全部测试/vitest/DB/provider/runtime/Docker/paid（owner 规则；本片
不触五类不变量）。globals.css 等存量 warning 未处理（写权外）。

## 证据

仓库外封存：`tlp-audit-artifacts/architecture-deepening/YUK-1572/<head>/
assessment-publication-read/`（diff、前后文件、对账脚本与输出、五门 raw
stdout/stderr + meta、SHA256 清单；59bc 目录另有父 frozen-install 与
function-proof 回执）。
