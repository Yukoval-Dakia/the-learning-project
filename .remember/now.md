# 当前 handoff — 2026-08-27（ModelProfile 落地后，main @ 354982ae）

## 本日全景（累计 38 票 Done + 14 Canceled，38 PR 合并，开放 PR = 0）

1. **纠偏四连**：Buildkite 停止 → 工具链移出 gate（#1262）→ 产品三连（#1250/1251/1252）→ YUK-898 移除项目级声明（#1264）+ YUK-846 结案。
2. **批准件全落**：903/596/913/911/339/340/784/496 方案A 全部落地。
3. **工程面**：522/909/605+555/893/739/plan-then-generate(#1282)/ADR-0038 修订(#1277)/537/390residual/391 五+1 镜像收敛——kind 两轴正交化 epic（YUK-386）四步全完成。
4. **YUK-839 全链收口**：工程(#1275) → R1 FAIL(#1283) → R2 诊断 PASS(#1286，resume 铁证) → owner ①b 裁决 → flash 预算档(#1294) → **Done**。
5. **owner 六项裁决全部执行（#1292-#1295 + 关票×2 + 停放×1）**：
   - ①b flash 预算放宽（#1294，模型感知 durable 预算档 20/10min）→ 839 Done；
   - ②a 手稿语气（#1293，设计源四条规则进 chat system prompt）；
   - ③LIGHT（#1292，ADR-0046 四项逐条豁免登记）→ 679 Done；
   - ④⑤ 371/899 Canceled；⑥ 921 维持停放（记录在票）。
6. **flash 耗时根因调查**（owner 提问驱动）：R1 主因 thinking 失控（480s 零 tool_use）、R2 主因多轮全上下文重发（354k input ≈12 轮）；端点健康 ~45tok/s；SDK teardown 延迟 9-10min；MAX_THINKING_TOKENS 不穿透 CLI（记忆 #466）。
7. **派生新线全部落地**：YUK-923 SDK effort 档位透传（#1295，Done）→ **YUK-924 ModelProfile 注册表（#1297，Done）**——owner 两问裁决：P1+P2 一张票 / models.dev 远程目录 + OpenCode 式 provider 绑定。落地：models.dev committed 快照（`pnpm gen:model-catalog` 再生成，运行时零网络）+ config-over-catalog 三层 merge（provider modelDefaults + models map + 三态保守默认）+ P1 五点收编（零行为变更 + 平价测试）+ P2 capability fail-closed 闸 + run metadata 来源链。实测 catalog 对四活跃模型全覆盖；mimo text-only catalog 声明按仓库运行证据（VisionExtractTaskHeavy multimodal 救援线）用 binding 覆盖。
8. **后续已立票**：YUK-925（R3 burn-in——effort@high thinking 降幅实测，owner 闸：真 token ~$1-2 授权即跑）；YUK-926（not-material 批量提交，轮次 12→8，归因纪律排在 925 后）。

## 待 owner（唯一）

YUK-924 两问（P1+P2 一张票 vs 分期；手写本地 profile vs models.dev 远程目录）——拍后开 lane。

## 工程池状态：已清零（924 除外）

全部 actionable 票已落地或转入 owner 闸。可选低优先未立票：validator prompt 引导 not-material 批量提交（耗时 L2 杠杆）；flash@high 真实 burn-in 验证。新工程输入到达后按 mass-ulw 纪律（逐票拉实时→验证→隔离 worktree lane→审 diff→过闸→合并）续推。

## BLOCKED-ON

- 生产部署授权不变（887/859/856，不变项）。
