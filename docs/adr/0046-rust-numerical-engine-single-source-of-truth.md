# ADR-0046 — Rust 作为确定性数值引擎（single-source-of-truth）：TS 去 oracle 化

**Status**: Accepted (owner 2026-06-26)
**Part of**: YUK-495（Rust 同构核心）。**反转 YUK-493 滩头对数值核的「JS oracle + fallback / Rust dev-CI-only」立场**（见 §背景）。
**Decision source**: owner 2026-06-26 对话——「rust 现在被视为 check 是吗，我觉得干脆不要让 ts 做算法」+「S5 #41 不要 defer 数学上 rust」。承接 Rust Phase 1（#596 共享多项式 σ · #607 #125 solver · #610 schema 加宽 · **#613 WASM execution-parity** 解除 WASM-in-browser 底座）。
**Related**: ADR-0043（difficulty 校准，θ̂/b 数值核）· ADR-0035（三轴正交 + 四引擎，数值核边界）· ADR-0044（event-sourcing——θ̂/mastery_state 是命令式 UPSERT + 快照、与 SoT flip 解耦，本 ADR 不改其事件溯源面）· 滩头设计 `docs/design/2026-06-24-rust-napi-calibration-beachhead.md` · Phase 0 spike `docs/design/2026-06-25-rust-coldstart-phase0-spike.md` · WASM parity（PR #613）· tripwire（记忆 `project_rust_isomorphic_core`）。

---

## 背景

YUK-493 滩头定的姿势（至今）：**TS = oracle + 生产路径，Rust = 被 parity test 验证的镜像**。生产里真正跑数值的 live TS 是 `src/core/theta.ts`/`pfa.ts`（θ̂/PFA——**当前仍用 `Math.exp`**，polySigmoid swap 是**未落的 Phase-1 动作**，不是已接线）。`src/core/poly-exp.ts` 是 Phase-0 de-risk 模块，与 crate 的 `poly_exp.rs` **双维护 + parity-locked**（drift-risk + parity-ceremony 的代价是真的）但**尚未接进 live sigmoid**；`src/server/calibration/*` 是 offline / report-only、**不在 prod 镜像**。`crates/calibration-native` 的 `.node`/`.wasm` **opt-in / gitignored / dev-CI-only**，`native-parity`/`poly-exp-parity`/`wasm-parity` 三套件 skip-if-absent，**JS 永远是 always-on 生产路 + fallback**。后果：数值算法**维护两遍**靠 parity test 锁同步（poly 已是 `poly-exp.ts` ↔ `poly_exp.rs`；θ̂/PFA 一旦 port 就成同样双份）——这正是反转要消除的。

owner 2026-06-26 的观察：**Rust 被摆成 check（验证镜像），不是引擎。** 双实现 + 同步成本是错的取舍。

**关键区分（决定本 ADR 的核心）**：
- Rust 的**性能**价值是 **tripwire-gated** ——两轮栈瘦身 audit 实测 TS 数学 sub-µs、pipeline I/O-bound、Rust 提速 ≈0；napi promote 到 prod 此前 gated on 数据（单学习者 scorable event > ~5000，或数值引擎成 recurring worker job）。
- Rust 的 **single-source-of-truth / 同构 by construction** 价值是**数据无关、立即生效**的：一份实现编 napi（服务端）+ WASM（浏览器）→ 逐位相同**不靠 parity test 去证**，且无双维护。
- #41 recompute 徽章 / #45 reproducible calibration card 把「浏览器端 bit-exact 重算诊断数字」变成 **product 目标**，使双实现的同步成本不再是内部债、而是用户可见正确性面。#613 已证 WASM execution-parity 端到端可行（server napi ≡ browser WASM ≡ oracle）。

owner 选**架构纯度（single-source-of-truth）**，明确**不是为速度**（速度仍 tripwire-gated）。本 ADR 钉死这个反转。

## 决定

### 1. 确定性数值核 = Rust single-source-of-truth

θ̂ / PFA / calibration（AUC/bootstrap/ECE）/ proper-scoring-rule / 任何**纯数值确定性 kernel**：**一份 Rust 实现**，napi 喂服务端、WASM 喂客户端（仅在计算真露出客户端处，如 #41/#45）。**TS 不再重写这些算法——只调 binding。** `poly-exp.ts` 这类 TS 数值实现是迁移期 oracle，终态删除（见 §4/§5）。

**FSRS 例外说明**：repo **不自造 FSRS**（`fsrs.ts` 是第三方 `ts-fsrs` 薄封装，无 first-party retrievability 公式可 port）。「FSRS 进 Rust」**仅指 retrievability 公式那一截**（对齐 Rust catalog decision③ / #105 含 FSRS / #30 Twin 用 Rust FSRS），且 `ts-fsrs` 仍是持久化 Card 的 **TS single-writer**（ADR-0005/0035），**不是迁移 FSRS 调度**。ADR-0044 已记「ts-fsrs Card 重放确定性难保证」→ 排序 **deferred 到 #105/#30**，**非近期 §4 迁移项**。

### 2. 边界（铁律）：数字 → Rust；编排 → TS

**只有确定性数值计算进 Rust。** LLM 推理 / matcher / judge / 错因归因 / conjecture 引擎 LLM 半边 / 组卷流 / DB 读写 / HTTP / 调度*决策* → 全留 TS。**Rust NEVER touch LLM / DB / OCR**（不变红线，权威 = 滩头 §2.3「Rust 只收已组装数组、绝不跨 FFI 碰 DB」+ 本节 +−×÷ 判据；ADR-0035 只管三轴正交，非本边界）——它们 I/O-bound、Rust ≈0、且会把 Agent SDK / pg / R2 拖进 crate。判据一句话：**「给定输入纯靠 + − × ÷ compare sort floor exp 算出确定输出」→ Rust；「要问模型 / 查库 / 发请求 / 软判断」→ TS。**

### 3. Rust 进 prod（反转滩头立场）

数值核 binary **ship 进生产**：Dockerfile 在镜像里 build `.node`（per-arch）或 Node 运行时 load `.wasm`。**这反转 YUK-493 滩头「JS 永远 oracle + fallback、Rust 只 dev/CI」对数值核的立场**——数值核的生产路径从今往后是 Rust，不是 TS。（滩头的 skip-if-absent 契约只在**迁移期**对**尚未迁的**计算保留。）

### 4. Forward-only 迁移（不大爆炸）

- **新数值 kernel 一律 Rust-first**：无 TS oracle，直接 Rust 实现 + Rust-native 测试。不再制造新的双维护。
- **既有 live TS（`theta.ts`/`pfa.ts`/`calibration/*`）触到才迁**：port 进 crate → 切 caller 调 binding → **删 TS 实现**。**不主动重写在飞的 θ̂ 生产路**（B1 载体 live 在喂 `mastery_state`，逐计算点迁、port 即删，每步独立可验、可回滚）。
- A13 proper-scoring kernel = **首个 Rust-first 试点**（净新、边界干净、不碰 live θ̂）。

### 5. TS = 用完即弃设计脚手架，非永久 oracle

设计期允许在 TS 里 prototype 未定型的数值算法（快迭代、无 recompile），但路径是 **prototype → port 进 Rust → 删 TS**，**不是 TS 当永久 oracle**。这保住设计期迭代速度，终态仍是单实现。区别于滩头：滩头的 TS 是**永久** oracle + fallback；本 ADR 的 TS（对数值核）是**临时**脚手架。

### 6. napi/WASM 安全约定（working-name「ability-island」）升格为 prod-safety 契约

napi 约定——**反转后从 dev/CI 惯例升为生产正确性契约**，本 ADR 吸收（不另开 ADR）：
- `#![forbid(unsafe_code)]`（crate 级）——⚠️ **当前 crate 实测无 unsafe 但尚未加该 lint attribute，待 Rust 线落地**（下列其余约定已在 `lib.rs` 落地）。
- **owned args**（`Vec<f64>` 传值，非 borrow / 非 Buffer）——labels 用 `Vec<f64>`（非 `Vec<u32>`）以**避开** N-API ToUint32 对非二元 label 的静默强转（`1.5→1` / `-1→4294967295`），保持非法-label throw 与 oracle 字节一致（见 `lib.rs:16-19` labels 注释）。
- **无 FMA**（`f64::mul_add` banned）+ 冻结 Horner 序 + floor-based range reduction + 常量 from_bits——确定性不变量，跨 V8/native/wasm 位等的前提。
- **迁移期 = diff-test**（vs TS oracle，Object.is）；**单实现后 = Rust-native KAT/property test**（无 oracle 可比时）。
- `seed-not-closure`（FFI 传 seed 非 rng 闭包，整条 PRNG 流在 Rust 跑）。

### 7. n=1 红线不变

不拟合 item 参数（DROP-7 墙：b/a/c/slip/guess/DIF）；`b` 处处只读；任何 SoT/flag flip owner-in-loop。数值核进 Rust **不放松**这条——proper-scoring 是 per-learner cohort-free，n=1-safe。

## 诚实天花板 / 后果

**正面**：一份实现、无 drift、同构 by construction（非 by parity-test）、forward 无双维护、确定性是生产契约而非测试附注。

**代价（不藏）**：
- **Rust-as-prod-dep**：Dockerfile 要 build 数值核 binary。**Q1 NAS CPU arch（arm64 vs x86_64）必须解**（per-arch `.node` 或统一走 WASM-in-Node）。server 侧 **napi(.node) vs WASM-in-Node** 是 impl 决策（napi 快、wasm 跨 arch 可移植、loader 重）。
- **无 TS fallback**：Rust load 失败 = 该计算无算法。单用户自托管可接受，但是**自觉选的健壮性取舍**（非默认安全网）。
- **迁移风险**：live θ̂ 在飞 → §4 的逐点迁 + port-即删 + 每步独立验是风险控制手段；任何一步破 `mastery_state` 写路 = 立即可见回归。
- **设计期迭代摩擦**：未定型算法直接 Rust = 每次调参 recompile + 守确定性纪律 → §5 scaffold-then-delete 缓解，但承认比纯 TS 慢。

**parity-test 姿势变过渡**：`native-parity`/`wasm-parity`/`poly-exp-parity` 在迁移期验证 TS↔Rust；某计算单实现后（TS 删）**无 oracle 可比** → Rust-native KAT/property test 接管。**YUK-501**（parity 套件 CI 执行 lane）迁移期升重要，之后角色转为 Rust-native test 执行。

**tripwire 重framing**：Rust-in-prod 现由 **single-source-of-truth 证成（立即）**，非 speed（数据门）。**tripwire 的「napi-promote-on-data」对数值核被本 ADR superseded**。tripwire 仍管**重算力引擎**（grid-Bayes / bootstrap / MC / EM）是否值得 **napi-recompute 性能优化**——那是独立 perf 问题，仍 gated on 负载真实（>5000 scorable 或 recurring worker job）。即：**「数值核用 Rust」= 架构决策（now）；「重算力走 napi 提速」= perf 决策（data-gated）**，两件事。

## 替代方案（已拒）

- **保 TS-oracle + Rust-mirror（status quo）**：拒——永久双维护 + drift-risk + Rust 永远是 dormant check。
- **大爆炸全迁数值核到 Rust（now）**：拒——live θ̂ 生产路风险 + 设计-churn 期迭代摩擦。forward-only + 触到才迁是风险折中。
- **TS-only 弃 Rust**：拒——丢同构浏览器 bit-exact 重算（#41/#45 product 目标）+ 确定性核 thesis；且 #613 已证浏览器路可行。

## Coordination / Open

- 这是 **YUK-495 架构决策**。**Rust 线在另一 session 活跃**（babysit-merge #607/#610/#613 + S5 recompute badge `yuk-495-s5-recompute-badge`）→ 本 ADR 是协调 artifact，**任何动 `crates/calibration-native` 的实现必须由 Rust 线 owner、不跨 lane 改 crate**。
- **A13 proper-scoring kernel = 首个 Rust-first 试点**（YUK-440/406；本 ADR 把它从「TS-first + 留 Rust follow-up」改为 Rust-first 单实现）。
- **Open（impl 期定）**：Q1 NAS arch；server napi vs WASM-in-Node；fallback policy（hard-fail vs degrade-to-cached）；既有 `theta.ts`/`pfa.ts`/`calibration/*` 的迁移顺序（建议 calibration 先——已部分在 crate、边界最干净）。
- 本 ADR 吸收 working-name「ability-island」napi 安全约定（§决定6），**不另开 ADR**。
