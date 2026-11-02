# 录入详情费用 LIGHT：现役消费与状态呈现

原 YUK-1473 / YUK-1522 已授权范围；基线 `2c3c212934c9b6a95a788612dd477c1ab98119be`。同一父 writer 在独立父工作树串行实施，不改变做题整页候选及其排期。用途 consumer 的审查和业务逻辑不重开。

## UI preflight

`docs/design/2026-10-27-m3e-direction-and-migration.md:9`：
> Owner 已明确 UI 设计、实施、视觉复核由 **Astra** 承担，全面采用 **Google Material 3 Expressive（M3E）**，严格依据 Google 官方规范。

同文 `:18`：
> M3E 改变视觉语言与交互呈现，不重新决定选题、判分、建议生效、题目可用性、读写或恢复规则。

组件类型：other（现役录入详情内的费用证据 section）。修改 recording-read.ts、recording-model.ts、RecordingSheet.tsx；新增 CostSection.tsx、record-cost.css；tokens.css 仅增加 record-cost opt-in，不改现有角色值。另新增本说明。不改 transport/client/Start、后端、schema、依赖或测试。

官方依据：2026-10-30 直读 [Google M3 in Compose](https://developer.android.com/develop/ui/compose/designsystems/material3#typography)，其类型层级、surface/on-surface 配对可读；采用现有 Web token 中 headline-small 24/32、title-medium 16/24、body-medium 14/20。Android 的 sp 不是浏览器像素等价保证，本片沿已合 Web 映射，不引入 Compose 依赖。[M3 applying type](https://m3.material.io/styles/typography/applying-type) 直读仍为 JS 壳，未声称获取其完整组件细则。

呈现：费用作为独立阅读区，标题和覆盖说明在前；每币种已知小计为数字主层，reported/estimated/legacy 为三项次级定义列表，非按钮/胶囊。缺证说明与金额并存，明细在原生 details 内展开。只读内容无额外 tab 停点；唯一操作复用原录入手动刷新，不新增查询/轮询/写入。局部圆角、间距、明暗色及焦点沿 M3E 角色，长币种/身份换行，窄屏改为单列。

## Wire 与状态

完整合同：`/Volumes/YukovalSBak/yukoval-projects/tlp-status/review/stage1-functional-remaining-20261027/ui-session-cost-wire-handoff-603a26b09.md`。

沿 getHistory → historyQ → Recording → RecordingSheet → CostSection 原链；证据类型直接取生成 `SessionHistory['cost_evidence']`，无第二 schema。只接受 session.id 等于当前录入的历史；placeholder 仅在同会话状态变更时保留，不跨会话。保留的证据始终带原 as_of，读取错误时标为旧快照，不称刷新成功。

服务端 by_currency 的 known_subtotal/reported/estimated/legacy 原样呈现，不重算、不互相相加、不换汇；总额仍未知，partial 始终可见。数值用 JS number 的原字符串，不以货币小数位舍入，0 显示 0，null 显示金额未知，小额非零不显示成零或免费。缺字段、加载、读失败（含404/503）分别表达；费用错误不修改录入业务 phase。完整 missing/unsettled 原因用通俗文案，未确认记录不是调用次数/重试许可。

## 验证边界

本轮 source-only，无新增 useEffect。tests 零写零跑；业务 HTTP、浏览器、DB、provider/paid、实际用途变更/停止/清理及部署 NOT_RUN。必要本机 typecheck/lint/build、相关 audit 与本片唯一独立 R1 按实际结果记录；源码和静态门不替代真实费用/界面验收。共享 Linear field notes 接口返回 `Tool get_agent_context not found`，以固定交接与真实源码为准。

本机 api-client-usage、capability-boundaries、architecture-deepening、learner-copy、typecheck、lint、build 均 exit0；六个源码文件 Biome 无诊断，diff check 通过。依赖由已有离线缓存安装，package/lock 未改。独立首次 R1 尚待完成。

证据目录：`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/yuk1473/record-cost-light-20261030/`，checks.json 和各门日志；固定源码/摘要与审查结论在同目录独立保存。读失败、旧服务缺字段、同会话旧快照、切换会话、真实零/未知/非零小数的判读由源码分支核对，未执行模拟或运行测试。
