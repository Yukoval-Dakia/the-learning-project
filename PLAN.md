# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像 NOW / NEXT / PARKED / BLOCKED-ON。
> 更新于：2026-08-27（ModelProfile 落地，main @ c67b68b6）

## NOW

- **owner 六项裁决 + 两项追加裁决全部落地（2026-08-27，六 PR 连收 #1292-#1297）**：
  - ①b flash 预算放宽（#1294 模型感知 durable 预算档，flash tier 20/10min）→
    **YUK-839 Done**；
  - ②a 手稿语气（#1293，设计源四条规则进 chat system prompt）；
  - ③LIGHT 豁免登记（#1292，ADR-0046 逐项 + 文件头指向）→ **YUK-679 Done**；
  - ④⑤ 371/899 Canceled；⑥ 921 维持停放。
  - **YUK-923**（SDK effort 档位透传，#1295）Done；
  - **YUK-924 ModelProfile 注册表落地（#1297）**：models.dev committed 快照 +
    OpenCode 式 provider 绑定（config-over-catalog，运行知识覆盖 catalog——
    mimo 的 multimodal 声明按仓库证据覆盖 text-only catalog）+ P1 五点收编
    （零行为变更 + 平价测试）+ P2 capability fail-closed 闸 + run metadata
    来源链。
- **flash 耗时根因调查**（burn-in R1/R2 数据）：R1 主因 thinking 失控（480s
  零 tool_use）、R2 主因多轮全上下文重发（354k input ≈12 轮）；端点健康
  ~45tok/s；SDK teardown 延迟 9-10min；MAX_THINKING_TOKENS env 不穿透 CLI
  （推理控制面 = SDK effort 档，已接）。
- 本日累计 **38 PR 合并**，开放 PR = 0。

## NEXT

1. **YUK-925**（owner 闸：真 token 授权 ~$1-2）：R3 burn-in 测 effort@high 的
   thinking 降幅——单变量归因，预期 reference 单腿 ~7min 重回产品预算邻域。
2. **YUK-926**（排在 925 后，归因纪律）：validator not-material 批量提交
   （轮次 12→8，输入总量 -35%）。
3. 新工程输入（新票 / 裁决）到达后按 mass-ulw 纪律续推。

## PARKED

- **多 provider 方案一**（YUK-921）：方向已批、实施搁置；重启时 execution
  adapter 可直接复用 ModelProfile 的 provider 绑定面；先答两开放问题
  （codex-sub 用途层级 / grok 接入形态）。
- A3 裁决维持（8 张 Canceled / human-gated 躺平 / strategic 不动）。
- 本地 main 脏树残余 = `.codex/config.toml` + 未跟踪工具目录（无害）。
- YUK-360 blocked-on-upstream（mem0 usage API）；yuk-822 worktree 待 owner。

## BLOCKED-ON

- 887 / 859 / 856：生产部署授权闸（Architecture Deepening 收口条件，不变）。
- Production rollout / observation：无授权不起（不变）。
