# YUK-1570 — json-extract / json-sanitize 纯算法族迁入 src/core

- branch: `arch/yuk-1570-json-algorithms-core`
- base: `ce74a7733f93044f55c0b00d056ae3c8d137f1fc`（origin/main fixed SHA）
- worktree: `/Users/yuqi/.t3/worktrees/the-learning-project/t3-774a63b2`（仅写本树）
- 状态：源码迁移与原子退出已完整落地（9/9 consumer、两旧真身删除、baseline 按真实
  audit 实测登记）。机器验证与封存证据见下。
- 仓外证据：`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1570/<head>/json-extract-sanitize-core/`

## 范围（逐文件）

新建（真身迁入，非 wrapper/shim）：

- `src/core/json-sanitize.ts`（83 行）= `src/server/orchestrator/json-sanitize.ts` 逐字节复制。
- `src/core/json-extract.ts`（291 行）= `src/server/ai/json-extract.ts` 复制 + 恰好 3 行差异：
  - L24 import specifier `@/server/orchestrator/json-sanitize` → `./json-sanitize`（族内边，core 零 server 依赖）；
  - L18、L167 注释中两处失效路径字样最小改写（`src/core/json-sanitize.ts` / `同簇 json-sanitize 状态机`），无语义改动。

删除（原子退出）：`src/server/ai/json-extract.ts`、`src/server/orchestrator/json-sanitize.ts`
（`src/server/orchestrator/` 目录随之清空消失）。

修改（仅 import 字面量 hunk，正文零改动；9/9 consumer）：

- extract（7）：`recommend.ts`(agency)、`quiz_gen.ts`、`quiz_gen_plan.ts`、
  `intervention-author.ts`、`multimodal-direct-judge.ts`、`web-sourcing-operation.ts`、
  `verify-framework.ts:43`（C 释放后由本片按已批 hunk 完成，Biome 序位移至 L6）；
- sanitize（2）：`solve-session.ts`、`teaching-turn.ts` → `@/core/json-sanitize`。

文档事实清账（父授权的两处，其他条目不整治）：

- `src/capabilities/practice/CONTEXT.md`：旧 `@/server/orchestrator/json-sanitize`
  豁免注记改写为 core 事实（豁免已清账）；
- `src/server/AGENTS.md`：删除失实 `orchestrator/` 行（目录已不存在），其余条目不动。

baseline：`scripts/capability-boundary-baseline.json` 经 `pnpm audit:capability-boundaries
--tighten` 机制按真实实测登记 decrease（append-only，4 条 changes 记录，UTC 2026-10-20；
edgeRecords 20 条 / compatShims 7 条 / 历史 changes 全原样前缀）。不签 stable/compat。

## 闭包与消费者证明

全仓 import 字面量普查（`.ts/.tsx/.mts`，排除 node_modules/dist）：旧两模块真实 consumer
恰为 9（extract 7 + sanitize 2），全部指向 `@/core/*`；族内边 `src/core/json-extract.ts` →
`./json-sanitize`。旧路径零残留；无 barrel/re-export、无测试文件、无 audit 脚本钉住。

## 语义保真

迁移为 byte-move：strict parse 首路径、确定性转义（内容引号/非法反斜杠/裸控制字符）、
容器闭合触发与风险拒绝、riskyRepair/containerClosure/latexEscapes 选项语义、jsonrepair
依赖与梯度顺序、原 SyntaxError 对象与消息、`[json-extract]` console.warn 前缀与条件、
无 `{...}` 时 null——全部逐字节保留。不触及 AgentRunError /
provider-session-admission / 错误 class / hash 规范化 / paid consumer 正文。

## 两个真实变化场景

1. 修复算法规则变化（如调整梯度顺序或新增确定性转义）：迁移前改 `src/server/ai/` 与
   `src/server/orchestrator/` 两个 server 子树；迁移后整条规则族同处 `src/core/json-*.ts`
   单目录。接口与 caller 步骤不变。
2. 新领域 consumer 用纯算法：归属依据是「完整纯算法、零 runtime 依赖」——算法本身不
   依赖 server 运行时，新消费者经 `@/core/*` 引用即可。如实说明：本片是完整职责归位 +
   同接口迁址，接口未深化、caller 步骤未减少；core 不被三类 ratchet 边审计覆盖这一事实
   是边界规则的既有后果，不单独作为收益证明。

## 五标准对账

- 责任：LLM 输出宽松 JSON 提取/净化一族一责，未变；
- 接口：`parseJsonObjectLoose` + `LooseJsonResult`/`ParseJsonLooseOpts`/`RepairLevel` /
  `sanitizeJsonStringLiterals` 签名与语义零变化；
- 隐藏知识：梯度顺序、转义启发式、闭合策略仍在族内，不外泄；
- 修改局部性：规则族由两个 server 子树收拢到单一 core 目录；capability→server 债边
  实测 −9（见下），是归位的结果不是目标；
- 行为证据：见「机器实跑」。

## 行数与边界

原 291+83 行 → 新 291+83 行；两文件均远低于 1500 行阈值。拆分边界成立的依据是两族
各有独立 live consumer 集（sanitize 单用：teaching-turn / solve-session；extract 全量
梯度：quiz supply 族），合并会强迫 sanitize-only consumer 牵连 jsonrepair 依赖；
如实说明非为行数拆分。

## 实测差量（audit 官方 file→module 单位）

`pnpm audit:capability-boundaries` 实测 → `--tighten` 登记：

- `agency -> ai` 25→24、`practice -> ai` 61→55、`copilot -> orchestrator` 1→0、
  `practice -> orchestrator` 1→0，capabilityToServer total 403→394（−9）；
- serverToCapabilityDeep 0、crossCapabilityValue 37 不变；kernel/core→server 新边 0；
- `pnpm audit:architecture-deepening`：dependency totals 394/0/37 < 531/70/62，
  pass-through sites 1088（+0 new），SCC/ownership/queue/provider-lane 全部通过。

## 机器实跑 / NOT_RUN

- heavy.sh 串行实跑（raw stdout/stderr + argv + UTC + 真实 rc 封存于仓外
  `final-runs/`）：typecheck / lint / build / 两 audit，结果见最终 head 封存。
- 依赖来源：父一次 frozen install（`pnpm install --frozen-lockfile` rc0，
  `226…/parent-frozen-install.json`，log sha256 98560ead…）；本 writer 未再 install。
- NOT_RUN：本机 tests / vitest / DB / provider / runtime / Docker / 部署；
  不 push / 不开 PR / 不发 review——父统一集成验收。
