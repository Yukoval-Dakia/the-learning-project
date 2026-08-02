# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-08-02
> **【YUK-840 active：Architecture Deepening FULL / Phase 0】**

## NOW

- **Owner 已明确「直接启动 FULL」。** 新 Linear project
  `Architecture Deepening FULL — 语义、成本与运行所有权` 已 In Progress；F0 依赖为
  YUK-840 → YUK-841 → YUK-842。
- **YUK-840 已进入 In Review。** PR #1155，branch `codex/yuk-840-full-f0`，base
  `origin/main@19a97b89`；原 checkout 的用户/其它 lane 改动未触碰。
- Phase 0 已本地落下 ADR-0051、current-code Phase 0/1 execution addendum，以及加深后的
  `audit:capability-boundaries`。语义边 baseline 为 capability→server 538、server→capability
  deep 70、cross-capability value 63；value 图有 1 个五 owner SCC。
- 在 owner 提醒「gate 不要在本地跑」前，定向 audit、10 个 unit tests、typecheck、lint、build
  已完成且绿；此后没有再运行本地 gate。两路独立只读 review 已清零 P0/P1；修复后
  exact-head CI 尚未运行，因此 **YUK-840 未交付**。
- **YUK-596 transport/Stop 与 actual burn-in 证据保持已交付；产品内容仍 HOLD。** YUK-832–836
  没有取消或完成，只因 owner 切换 active 主线而暂停。

## NEXT

1. 等待 PR #1155 exact-head GitHub CI 执行完整 gate；不在本地重跑。
2. CI 绿且无新 validated P0/P1 后 merge，再将 YUK-840 标 Done。
3. YUK-840 merge 后启动 YUK-841 单一 attempt 成本真相；完成后再启动 YUK-842 provider-lane
   admission。共享 schema/runtime lane 不并行。
4. F0 全部通过后，按 execution addendum 建 Phase 1 milestone/issues，迁 practice-owned
   failure-learning vertical；必须删除旧 knowledge/central handler/tool 双轨。

## PARKED

- **YUK-832–836 actual-output P1**：保留原优先级与证据，FULL active 期间暂停，不用架构 gate
  冒充产品质量 gate。
- **YUK-813 / YUK-831 OpenCode**：按 owner 指示暂不处理。
- **YUK-815 / YUK-816**：Grounding 后续协作与档案面；等待 active 主线重新排期。
- future/refinement backlog 不自动扩实施范围；到达时先核证 live consumer、重复与过期项。

## BLOCKED-ON

- **YUK-841** blocked by YUK-840；**YUK-842** blocked by YUK-841；Phase 1 blocked by F0 exact-head
  completion 与一个真实 provider observation。
- FULL 不触 UI；未来任何 UI 工作仍须 design-doc 逐字引用、组件类型与文件清单 pre-flight，
  owner 批准前不得写 UI。
- **YUK-571 / YUK-405 / YUK-406** 仍等待真实内容、首次 placement 与 owner 观察窗口；
  synthetic/mock 不能冒充验收。
- 严格 issue=0 仍含 future、数据触发、生产 flip 与大 epic；不能靠连续写代码伪归零。
