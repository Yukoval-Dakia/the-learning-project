# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像 NOW / NEXT / PARKED / BLOCKED-ON。
> 更新于：2026-08-16（ticket 归零 drive 首日收尾·二版）

## NOW

- **ticket 归零 drive 首日完成：批 1/2/3 全部清零。** main @ `abe8711f`（clean）。
- 今日合并 22 个工程 PR（净）：#1137（813）/#1214（843）/#1215（888）/#1182（457）
  /#1216（891）/#1217（836）/#1218（833+835）/#1219（834）/#1220+#1221（894）
  /#1223（889）/#1224（684）/#1225（291）/#1226（293）/#1236（806，lane 自主合并后
  补审 5/5 PASS 保留）/#1238（685，owner 批 FULL mass safe-fix）/#1237（826，owner
  裁决按正确性合入）/#1235（revert 1227）。另合 4 个绿 dependabot（#1228/1229/1230/1233）。
- **17 票 Done**：813/843/888/457/891/836/833/835/834/894/845/684/889/293/291/685/826。
- **YUK-360 回滚**：实施 lane 误按 07-01 旧批准实现 fetch shim 并自主合并（#1227），
  补审实证（openai 绑定 node-fetch 拦不住）后 revert（#1235），票退回 Backlog
  （owner 07-23 处置：等 mem0 官方 usage API）。YUK-906 随回滚作废。
- **YUK-826 验收重定标**：−72% 是 affected/full 口径假象；全量对比无可重复下降
  （DB1 +11.8%/SD 爆炸、DB2 −11%）；owner 裁决按正确性核销，数据留 PR #1237 评论。
- **dependabot 清零**：9 个新 PR 处理完（4 合 5 关）；TS7 迁移轨立 YUK-910。
- Track B 走查实证完成：判题链 mimo 兜底；894 三问重放全部降级出内容+低置信标注。
- A3 战略票分诊（95 票四桶）在 `.remember/a3-backlog-triage-2026-08-16.md` 待 owner 拍板。

## NEXT

1. owner 门槛项（见 BLOCKED-ON）：846 凭据轮换 wizard 备好；903/596 N4 UI 待批准。
2. 审理产出 follow-up：YUK-898（版本线）、901（input_json）、902（fallback 校验）、
   904（隐式指代）、905（validator 收紧）、908（zod 转换器收窄）、910（TS7 迁移轨）、
   907（293 Scope B）、909（biome 规则分批收紧）。
3. 走查产出：YUK-895（judge 422 UI 静默）、YUK-896（copilot 取消+阶段可见）、
   YUK-897（P2 十项包）。
4. YUK-599（N4 Dock 待 owner UI pre-flight）。

## PARKED

- YUK-360：blocked-on-upstream（等 mem0 官方 usage API），维持 owner 07-23 处置。
- Production rollout / observation 需独立授权（YUK-858 未部署，不变）。
- YUK-832 / YUK-839 保持 fail-closed HOLD；YUK-842 production 保持 observe。
- yuk-822 worktree 持 14 个未合并 YUK-792 提交与脏文件，待 owner 决定。
- 战略 epic 票 ~60 张保持 backlog，等 A3 清单拍板。
- YUK-899（reconciler 结算 P3）/ YUK-900（singletonKey 死选项）：小活，随批捎带。

## BLOCKED-ON

- **YUK-846（Urgent）provider 凭据轮换**：只能 owner 人工执行（2026-08-02 立案，
  15 天未轮换；wizard：`.remember/yuk-846-rotate-wizard.sh`）。
- **YUK-903（Dock「更正这轮」picker）**：待 owner UI 设计 pre-flight 批准。
- **YUK-596（durable flip + N4 Dock）**：转 Todo，剩余 scope 待 owner 批准 N4 UI。
- **YUK-898（插件版本线 keep-stable vs follow-beta）**：待 owner 决策。
- A3 砍/留清单待 owner 一次拍板。
- Production：无部署授权或真实观察证据（不变）。
