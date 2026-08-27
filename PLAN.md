# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像 NOW / NEXT / PARKED / BLOCKED-ON。
> 更新于：2026-08-27（终版后：六项裁决全部执行完毕，main @ 7ea7739d）

## NOW

- **owner 六项裁决全部落地（2026-08-27，四 PR 连收 #1292-#1295）**：
  - ①b flash 预算放宽（#1294：模型感知 durable 预算档，flash tier 20/10min，
    边界账本 copilot→ai 24/465）→ **YUK-839 Done**；
  - ②a 手稿语气（#1293：设计源蒸馏四条语气规则进 chat system prompt）；
  - ③LIGHT 豁免登记（#1292：ADR-0046 四项逐条 + 文件头指向）→ **YUK-679 Done**；
  - ④⑤ 371/899 Canceled（理由落票）；⑥ 921 维持停放（记录在票）。
  - 派生新线：**YUK-923**（SDK effort 档位透传，#1295，Done）、
    **YUK-924**（ModelProfile 模型能力档案，三方调研已备待两问）。
- **flash 耗时根因调查**（burn-in R1/R2 数据 + SDK 证据）：R1 主因 thinking
  失控（480s 零 tool_use）、R2 主因多轮全上下文重发（354k input ≈12 轮）；
  端点健康 ~45tok/s；附带发现 abort 后 SDK teardown 延迟 9-10min。

## NOW

- **mass-ulw 连续推进日收官**：全天累计 **31 PR 合并 / 34 票 Done + 12 Canceled**，
  开放 PR = 0。晚段三连：#1288（YUK-537 边 un-archive 仅 reactivate 清除）、
  #1289（YUK-390 residual：kind_cleanup_backfill job + 三科 fixture 规范化 +
  词表收敛地基）、#1290（YUK-391：五+1 处判分镜像收敛到 answer-class 派生谓词，
  含 9-kind×choices×profile 路由平价矩阵测试）。
- **kind 两轴正交化 epic（YUK-386）四步全部完成**：Step 3（#446+#1289）·
  freshness（#503）· Step 4（#1290）· Step 5（#1010，07-20 已落）。验证轴
  （answer_class 4 值）自派生到判分路由到生成端已是单一事实源。
- **YUK-839 双轮 burn-in 判定**（报告 #1283/#1286）：R1 产品预算 FAIL →
  R2 无限预算+thinking cap 16k 下 acceptance #6 机械层 PASS（resume 获真实流量
  铁证）；产品 480s 预算下 flash 不可达，生产纳入与否待 owner。

## NEXT

1. **YUK-924 两问待拍**（P1+P2 一张票 vs 分期；手写本地 profile vs models.dev
   远程目录）——拍后开 lane。
2. 新工程输入（新票 / 裁决）到达后按 mass-ulw 纪律续推。
3. 可选后续（低优先，未立票）：validator prompt 引导 not-material 批量提交
   （耗时 L2 杠杆，轮次 12→8）；flash@high 真实 burn-in 验证 thinking 降幅。

## PARKED

- **多 provider 方案一**（YUK-921）：方向已批、实施搁置；耦合地图完成
  （runner.ts 唯一硬绑点）；重启时先答两个开放问题（codex-sub 用途层级 /
  grok 接入形态）。
- A3 裁决维持（8 张 Canceled / human-gated 躺平 / strategic 不动）。
- 本地 main 脏树残余 = `.codex/config.toml` + 未跟踪工具目录（无害）。
- YUK-360 blocked-on-upstream（mem0 usage API）；yuk-822 worktree 待 owner。

## BLOCKED-ON

- 887 / 859 / 856：生产部署授权闸（Architecture Deepening 收口条件，不变）。
- Production rollout / observation：无授权不起（不变）。
