# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像 NOW / NEXT / PARKED / BLOCKED-ON。
> 更新于：2026-08-16（ticket 归零 drive 首日收尾）

## NOW

- **ticket 归零 + 可用性打磨进行中（owner 2026-08-16 授权）。** 口径：可操作票归零 +
  战略票砍/留清单一次拍板。
- **首日合并 10 张工程 PR，main @ `9a9f99f1`（clean）**：#1137（813 supply-chain
  fabf313c）、#1214（843 reconciler 行级隔离 baefd6f2）、#1215（888 notes 状态机拆分
  8ecb651a）、#1182（457 tool-use 卡片 ee1a4b49）、#1216（891 verify-dispatch 启动
  排序 277f7281）、#1217（836 correction 契约 549f6002）、#1218（833/835 学习内容
  validator a88de692）、#1219（834 owner-gate 契约 96b3922a）、#1220（894 验证预算
  降级 01811724）、#1221（894 残留：wall-clock deadline 形状分类 9a9f99f1）。每 PR
  均过五 lane 闸（FAIL 项修复后验证审 PASS）+ exact-head CI 绿。
- **Track B 走查实证完成**：判题链 B1 修复实证（注释 VISION_JUDGE_PROVIDER → mimo
  兜底 200/success）；894 三问重放全部降级出内容 + 低置信标注（不再是整轮拒答）。
- **A3 战略票分诊完成**：95 票四桶清单在 `.remember/a3-backlog-triage-2026-08-16.md`，
  待 owner 一次拍板。
- **A2 owner 行动清单**：`.remember/owner-action-list-2026-08-16.md`（846 凭据轮换
  wizard 第一优先）。

## NEXT

1. 批 2：YUK-889（burn-in fixture hygiene）、YUK-596（coverage ratchet）、YUK-360/293
   （现成分支意图重落到新 main，均单 commit、落后数百、热区重叠）。
2. 批 3（依赖迁移）：YUK-826/685/684/806/291。
3. 走查产出：YUK-895（judge 422 UI 静默）、YUK-896（copilot 无法取消 + 阶段可见性）、
   YUK-897（P2 十项包）。
4. 审理产出 follow-up：YUK-898（插件版本线对齐 owner 决策）、YUK-901（input_json
   内存放大）、YUK-902（fallback 绕过校验）、YUK-904（隐式指代静默改写）、
   YUK-905（validator 收紧四则）。
5. YUK-845 收尾确认（PR #1189 已合主线，票 08-15 退回 Todo：验证代码真相后 Done）。

## PARKED

- Production rollout / observation 需独立授权（YUK-858 未部署，不变）。
- YUK-832 / YUK-839 保持 fail-closed HOLD；YUK-842 production 保持 observe。
- yuk-822 worktree（the-learning-project-worktrees/）持 14 个未合并 YUK-792 提交与脏
  文件，非陈旧；继续 lane 或归档待 owner 决定。
- 战略 epic 票（YUK-203/452/453 等 ~60 张）保持 backlog，等 A3 清单拍板。
- YUK-899（reconciler 结算策略 P3）/ YUK-900（singletonKey 死选项）为审理产出，
  小活，随批 2/3 捎带。

## BLOCKED-ON

- **YUK-846（Urgent）provider 凭据轮换：只能 owner 在 provider 控制台人工执行**
  （2026-08-02 立案，两周未轮换；wizard 在 `.remember/yuk-846-rotate-wizard.sh`）。
  其余 human-gated：YUK-571/856/887/859/414/320/838。
- **YUK-903（CopilotDock「更正这轮」picker）待 owner UI 设计 pre-flight 批准**
  （LIGHT 方案在 PR #1217 评论）。
- Production：无部署授权或真实观察证据（不变）。
