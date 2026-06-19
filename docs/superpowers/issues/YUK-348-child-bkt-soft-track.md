# YUK-348 child(草稿) — B1 软轨第一增量:TS-native BKT 估计器 + 夜跑持久化

> Linear MCP 本 session 断开,无法程序化建 issue。本文件是 6-section 草稿,Linear 回连后归档为 YUK-348 child(或 owner 手动建)。

**area**: mastery / B1 · **parent**: YUK-348 · **status**: 起手即 In Progress

## 1. Problem / Context
ADR-0035 决定 #3(owner 2026-06-14 拍板「照字面全实例化四引擎」,覆盖工程建议)要求 IRT/CDM/KT 软轨**全实例化 + 持久化**。当前 `item_calibration` 的软轨列(`irt_a`/`irt_c`/`cdm_json`/`kt_json`)**恒 NULL、零 write path**(`schema.ts:861-864`,全在 audit-schema allowlist,`expected_by 2026-09-30`)。本 child = 四引擎中**最便宜、零 Python** 的第一刀,打通「软轨 write path + 夜跑 job + 红线守法」整条管线骨架。

## 2. Goal / Scope
**IN**:
- TS-native **BKT** forward 估计器(固定先验,纯算术递推,无 cohort 依赖)
- 软轨写者 `applyKtEstimate`(UPDATE `kt_json`,track='hard',单写者契约内,幂等)
- 夜跑 job `kt_estimate_nightly`(候选扫描 + per-question 隔离,照 `recalibration_nightly` 骨架)
- manifest cron 注册(错开夜链)
- 移除 `kt_json` 的 audit-schema allowlist 条目(接通 write path)
- **红线守法测**:kt_json 零决策/展示消费者;θ̂/p(L)/调度读路径在 kt_json 非空前后 bit-identical

**OUT(显式延后)**:
- IRT 2PL/3PL(`irt_a`/`irt_c`)+ CDM DINA/G-DINA(`cdm_json`)— 各自后续 child,**先单独决策 Python 微服务 vs TS-native**(见关联 spike)
- `mastery_state.calibration_residual` / `fluency_illusion_flag`(Wave2 复盘路径,另条)
- **任何 kt_json 下游消费**(展示下钻 / 决策)—— ADR-0035 决定 #4 红线明令禁止本增量做

## 3. Approach
新文件:`kt-estimator.ts`(纯 BKT forward)+ `kt-calibration.ts`(`applyKtEstimate`)+ `kt_estimate_nightly.ts`(job)+ 各自 test。改:`practice/manifest.ts`(cron)+ `audit-schema-allowlist.json`(删 kt_json 条目)。输入复用 `event` 表 outcome 序列 + 既有硬轨 `item_calibration` 行。

## 4. Acceptance
- BKT 估计器:连对→pL 升、连错→降;**空/极短序列 → 原样回吐 prior(prior-echo 断言 = 红线测)**
- `applyKtEstimate` 只 UPDATE track='hard' 行的 kt_json,不碰硬轨/其它软轨列,幂等,无硬轨行 no-op
- job 候选预筛正确(draft 排除、无序列排除),per-question try/catch 隔离
- **红线**:kt_json 写入不触达 mastery_state/p(L)/调度;独立 reviewer 核「零消费者」成立(非自审)
- Gate:typecheck/lint/**audit:schema(关键——allowlist 接通)**/audit:draft-status/audit:profile/**FULL pnpm test**/build 全绿

## 5. Risks(诚实)
- **n=1 prior-echo(核心)**:BKT 输出在 n=1 几乎全是先验回吐(pS/pG 结构性不可估,Stocking 1990)。价值 = 管线就位/期权/诊断丰富度/自校准残差,**不是可信参数**。代码注释 + 保留 allowlist 注释须诚实写明「实例化 ≠ 可信」(ADR-0035 决定 #4「最易被侵蚀的红线」)。job 早期几乎全 prior-echo 是**正常态非失败**。
- **red-line 守法(最高优先)**:最大失效 = 未来某 reader `SELECT kt_json` 喂进选题/展示。缓解=红线测 bit-identical + 独立 review 核零消费者。
- **audit:schema 接通交互**:删 allowlist 后须跑 `pnpm audit:schema` 验证 UPDATE-only write path 被认作有 write path(若 audit 只认 INSERT 需调整)。

## 6. Links
- ADR-0035 决定 #3/#4;`docs/design/2026-06-14-product-rethink-decisions-ledger.md:169`(Python 微服务草案,见 spike)
- **关联 spike(另草)**:评估 IRT/CDM 是否真需 Python 微服务 vs 全 TS-native prior-echo(decisions-ledger §169 落地决策)
- Refs YUK-348
