# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像 NOW / NEXT / PARKED / BLOCKED-ON。
> 更新于：2026-08-26（停止 Buildkite 切换 + mass-ulw 产品批次落地日）

## NOW

- **owner 叫停 Buildkite 切换**（2026-08-26）：YUK-916/917/918 Canceled，PR
  #1259/#1260/#1261 关闭（分支保留），/private/tmp worktree 移除；main 从未落
  Buildkite 文件，无需代码回滚。GitHub CI Gate 保持唯一 required gate。
- **工具链检查移出 required gate**：#1262 合并——static lane 删除
  `test:opencode-worktree` step；`verify:supply-chain` 降级为本地手跑（改
  `.opencode/` 时）。YUK-912/914 Done；registry 漂移不再阻塞任何 PR。
- **mass-ulw 产品三连落地**：#1250（YUK-289 科目筛选 tabs + notes list）、
  #1252（YUK-268 copilot session 管理 + 全屏）、#1251（YUK-897 P2 十项包）。
  集成裁决：notes 列表以 289 版为准，897 的 NotesIndexPage 删除；
  capability 债务吸收 copilot→session 5→6 / 总量 461→462（0bd5decb）。
  main @ `6a04523d`，push gate 绿。

## NEXT

1. **YUK-898 owner 决策**（插件版本线 keep-stable vs follow-beta）：决策材料已齐
   ——现状 verifier 仅本地手跑、preserve-only 草稿方向 = repo 不拥有第三方插件
   版本；拍板后处置草稿与 verifier 去留。
2. owner 门槛项（见 BLOCKED-ON）：846 凭据轮换 wizard 已备；903/596 N4 UI 待批。
3. A3 战略票砍/留清单待 owner 一次拍板（`.remember/a3-backlog-triage-2026-08-16.md`）。
4. 走查遗留小项随批捎带：YUK-915（QuestionsPage 复用 SubjectFilterTabs）、
   YUK-899（reconciler 结算 P3）/ YUK-900✓已清。

## PARKED

- preserve-only 草稿仍在本地 main 脏树（删 opencode 配置 + verifier 等），
  等 YUK-898 落地时统一处置；其 ci-gate/package.json 改动与 #1262 已语义重叠。
- YUK-360 blocked-on-upstream（等 mem0 官方 usage API），维持 owner 07-23 处置。
- Production rollout / observation 需独立授权（不变）。
- yuk-822 worktree 持未合并提交，待 owner 决定。
- 战略 epic 票 ~60 张保持 backlog，等 A3 清单拍板。

## BLOCKED-ON

- **YUK-846（Urgent）provider 凭据轮换**：只能 owner 人工执行；wizard 就绪
  （`.remember/yuk-846-rotate-wizard.sh`）。
- **YUK-903（Dock「更正这轮」picker）/ YUK-596（durable flip + N4 Dock）**：
  待 owner UI 设计 pre-flight 批准。
- Production：无部署授权或真实观察证据（不变）。
