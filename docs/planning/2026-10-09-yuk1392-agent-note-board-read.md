# YUK-1392 Agent-note board 公共读取

基线 main f80d47703；父票1358，整体退出1359仍 In Progress。1391已合入，不等于Start trait消费者或整页迁移完成。本线程7631承担整体交付责任，5796承担Start集成/发布；边界来自owner明确授权。

## Scope and contract

仅agency/api/notes.ts、agency/public.ts、必要server ISO DTO模块与scoped tests。原server/notes.ts selector、api/contracts.ts规则只读；无Start/UI/router/manifest/package/lock/writer/tasks/recovery修改。复用unfiltered readAgentNoteBoardRows，不替换成agent-filtered readAgentNotes。

公共输入与HTTP保持default20、positive integer、max200拒绝400非clamp，完整validation_error/errorResponse。Db|Tx显式注入，单次now；DTO created_at ISO并完整保留refs/provenance/expiry/unknown/enrichment。HTTP实际消费共享入口。已有Today20和agent-notes50不改。

## Evidence required

源码与mock测试不能代替真实DB：未提交非零Tx涵盖notes和每个关联lookup；全public表读取前后digest/count相同，rollback后fixture消失；同一now的HTTP完整DTO parity，expiry严格边界、稳定排序、20/50/200及非法输入、未知引用/空结果、长中文与嵌套来源。作者只scopedunit/static/build及适用audit，父DB实际核部署锁后独占执行。独立R1、exact CI与PR门禁。未完成部分不写PASS。

## Dedupe and ownership

1358全部10子票无重复，readAgentNoteBoardRows精确查询只有1359退出记录；历史294/311/313/629/293/907/1125不同scope。已建YUK1392。主线确认agency路径无重叠；只设一个writer。没有新增真相源或聚合层。Start挂载与页面真实验收归5796接续；领域slice不关闭1358/1359。
