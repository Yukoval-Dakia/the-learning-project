# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像 NOW / NEXT / PARKED / BLOCKED-ON。
> 更新于：2026-08-16

## NOW

- **架构深化已收口。** F4.1 定量审计合并于 `62e34a72`（#1211）；F3.2 TaskSpec 组合根
  （#1202）与 YUK-863 TaskSpec rework（#1183）均已进主线；51 项组成契约与 129
  prompt-hash oracle 进 CI。
- **ticket 归零 + 可用性打磨进行中（owner 2026-08-16 授权）。** 口径：可操作票归零 +
  战略票砍/留清单一次拍板。三路：A1 可关工程票 lane、A2 human-gated 合成 owner 清单、
  A3 战略票 triage；Track B 本地核心流走查并行。
- **清场进展：** dependabot 6 清零（#1184 vitest 4.1.5 / #1179 uploadthing 7.13.5 /
  #1091 import-in-the-middle 2.3.0 已合并；#1180 冲突、#1096 CI 红、#1094 eslint10
  迁移归 YUK-835/836，均关闭）。#1182（YUK-457 tool-use 卡片）与 #1137（YUK-813
  OpenCode 供应链闸）在 review-work 五 lane 闸中。

## NEXT

1. #1182 / #1137 过闸后合并；YUK-457 / YUK-813 关票。
2. A1 lane 批：YUK-845 收尾（PR #1189 已合但 08-15 票退回 Todo，先查原因）→ Copilot
   P1 四票 YUK-833/834/835/836 → YUK-888/891/843/889/596 收尾。
3. Track B：本地三进程栈走查做题 / Copilot / 笔记 / 录入 / 图谱，friction 当场立案。
4. A3：~60 张战略票砍/留建议清单交 owner 一次拍板后执行。

## PARKED

- Production rollout / observation 需独立授权（YUK-858 未部署，不变）。
- YUK-832 / YUK-839 保持 fail-closed HOLD；YUK-842 production 保持 observe。
- yuk-822 worktree（the-learning-project-worktrees/）持 14 个未合并 YUK-792 提交与脏
  文件，非陈旧；继续 lane 或归档待 owner 决定。
- 战略 epic 票（YUK-203/452/453 等 ~60 张）保持 backlog，等 A3 清单拍板。

## BLOCKED-ON

- **YUK-846（Urgent）provider 凭据轮换：只能 owner 在 provider 控制台人工执行**
  （2026-08-02 立案，两周未轮换）。其余 human-gated：
  YUK-571/856/887/859/414/320/838。
- Production：无部署授权或真实观察证据（不变）。
