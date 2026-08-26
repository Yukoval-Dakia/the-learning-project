# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像 NOW / NEXT / PARKED / BLOCKED-ON。
> 更新于：2026-08-27 凌晨（终版：mass-ulw 收官 + kind epic 全完，main @ c34fb647）

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

**工程池已清零**（已验证：全部 actionable 票落地或转入 owner 闸）。等 owner 六件：
1. glm-5.3-flash 是否进生产 validator lane（YUK-839 In Review，需 ≥25min 预算）
2. copilot 回复语气基调（YUK-340 停下的唯一分叉）
3. YUK-679 二选一：LIGHT（ADR-0046 豁免段）vs FULL（Rust port，需 Rust 线 lane）
4. YUK-371 关闭或改写（验收与 ADR-0038 修订冲突）
5. YUK-899 处置（票面截断不可恢复，三选项在票上）
6. 多 provider 方案一重启时点（YUK-921 停放中）

新工程输入（新票 / 上面六件的裁决）到达后按 mass-ulw 纪律续推。

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
