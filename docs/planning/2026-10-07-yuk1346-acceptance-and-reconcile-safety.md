# YUK-1346 实际验收与整理重投修复

2026-10-07。生产仍为 f3bfff2cfe2aea0efbf7d11ead8a84ebfab497ef；本记录不代表发布完成。

## 已观察的产品行为

精确源码 fea545aa1a853b1cc04da8e015bc3b40e61c4d1f，候选 ARM64 image sha256:bc9ab74220bd99be87a2ae72d60215899922261c998b288407b2ab7f9289c0f8。受限椭圆题 R4 的完整公开答案通过 existing_answer 判决、事实依据、独立盲解、全文 semantic correct 0.98 与教学检查。父核对数学 a²=25、b²=9、c²=16、焦点±4及浏览器刷新显示。受限轮 ingestion 没有 provider、queue、memory 增量；普通 A 的实际模型输入不含 R，A 完成并产生1024维偏好记忆。

原验收目录 /tmp/yuk1346-acceptance-driver/run-fea545a-01。R4 run copilot_user_ask_716cec3ba4a32dadcc1b77a60325aa0894799754cd5e0b67816ce17d16eee787；A run copilot_user_ask_56f67681c56affd6fb849078cac6d86b02f2f296d44b3ea04b169a8ca893ca1d。completed-R SHA cd6b96d4c183b707f3015202b2fe750cbc9ddd35377ab2bf8adefc07e943dbc5；completed-A SHA ad6ad6fa151d067142a269cd3eda746647958fe590f19c197f0b72423e2fd070；restricted-ingest SHA f26ee7b944e4cfa89f7be152d890bb47d8d36ee112112f253e82e92f5c3e4934。原件保持封存，不公开原始提示或思考。

## 失败及保留义务

提取成功后，验收脚本的未加引号 SQL alias 被 PostgreSQL 折小写，导致脚本在ACK前退出。物理 ingest e694ef1e-b7ef-457c-ba07-95648e4b5a6a 随后TTL过期，关联DLQ a8dd9b5f-ea85-4df9-a778-3f10ce04d681 保留。提取成功与物理任务失败分别记录，不重付、不清队列、不伪造ACK。

独立续验修正了观测脚本，不修改旧失败记录。r4 bundle ce43c6c5d7c8a873f2063ac461017dd53dbfaafb56ee39bbbc84b15efee0a589 的 observe/capture/finish-ingest 通过。第一次真实整理调用于08:52:51Z开始、08:53:51Z超时；attempt83073746-4d81-4170-93a8-dff152b303b6 为 aborted/provider_request_aborted、wire1，无 external request ID/usage/cost，无 reconciliation_log。不是 KEEP_BOTH 或成功，不重投。

父只读对照确认旧业务、事件、57条旧向量、旧调和记录及保留队列未意外改变；A产生的已知实体与SDK身份辅助写入单列。续验原本计划的SDK hook未命中pnpm真实路径，因此没有实际guard收据，不能声称运行了该guard。最终SQL只能证明观察到的一次同用户身份替换。

## YUK-1350 源码修复

诊断确认 direct reconcile 未启用已有 operation_kind start fence，普通同job重投可能发出第二次请求；这是源码及合成DB复现，不是宣称真实发生第二笔收费。另有 timer 在响应头后提前清除、未服从剩余deadline的问题。provider延迟原因仍未知，不擅自增加超时或改模型。

324381a3bb94486155d865d24e5ab504c97cafee 复用已有 fence，保留timer直到成功/错误响应体读取完成，在admission之后计算剩余deadline，并为实际未开始transport的情况记录wire0。保留未知费用、原始abort及HTTP/解析语义。

作者62 scoped unit、80 scoped DB、typecheck/lint/build及3 audits通过。DB使用独立testcontainers、真实handler/lifecycle加合成transport；旧源码复现第二次fetch，修复后off/observe/enforce模式同job重投总fetch=1，先前abort记录不变且无假结果或记忆修改。证据 /tmp/yuk1350-reconcile-safety-implementation/report.md。父已核对真实diff，独立42 unit与6个真实DB关键复验通过；没有第三轮PR审查、付费调用或生产写入。

## 尚未完成

新修复的exact-head CI、候选运行及剩余全局brief/原key幂等/重投/最终数据保护验收。旧R4/A实际结果不能冒称新镜像全量验收。新发布仍需新镜像、停写后新鲜备份与恢复验证。生产42 failed/42 DLQ保留。

已知累计模型估算USD0.020229617；SDK add/search/embedding及超时整理成本未知，继续占用既有保守$2预留。YUK1348记录普通回复错误否认记忆能力，YUK1349记录LaTeX显示问题，均未修。用户数据和历史失败不为得到绿色检查而删改。
