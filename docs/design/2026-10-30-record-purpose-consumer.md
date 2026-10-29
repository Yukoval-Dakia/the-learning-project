# 上传后用途变更：record 详情消费

基线：721b9d4822f80535a0ab176eecb3e0fa28ea9348。原YUK-1522/1473，FULL已批准；同一父writer在做题整页视觉验收等待期间串行实施，不占用其预览或新增writer。

## UI preflight

`docs/design/2026-10-27-m3e-direction-and-migration.md:9`：
> Owner 已明确 UI 设计、实施、视觉复核由 **Astra** 承担，全面采用 **Google Material 3 Expressive（M3E）**，严格依据 Google 官方规范。

同文:18：
> M3E 改变视觉语言与交互呈现，不重新决定选题、判分、建议生效、题目可用性、读写或恢复规则。

组件类型：other（现役RecordingSheet内用途设置及分项结果区域）。Owned：record-api.ts中两个canonical操作；新purpose-change.ts负责本UI命令身份及恢复；新PurposeSection.tsx/record-purpose.css呈现；RecordingSheet.tsx挂真实consumer；tokens.css仅在既有M3E选择器加入record-purpose opt-in，不改任何色值或其它页面绑定。复用原生成操作类型、apiFetch鉴权及apiOperationJson，不更改公共HTTP/Start transport、后端/schema/费用FULL。

## 请求与界面

先读取当前来源文档/version/policy，用户显式选择后冻结四字段输入。POST之前将原UUID/body/规范回执地址保存在当前标签页sessionStorage；存储失败不发送。刷新/收起再打开只GET同请求，404和网络错误保持未知，绝不自动另发新key。确需重试由用户显式点击，同key/body原样重放。来源/版本409保留原拒绝证据并重读，清除选择等待用户重新决定。crisis不可改。Location只接受同站点、同session、同request_id的canonical地址。

200只展示原请求政策已提交；当前政策单独GET，原回执目标读input.target。停止、每sink修复、摘要、整体cleanup/Mem0、准入历史和未归因/外部副本分别陈述；不推导全部停止、删除或免费，不复活历史。无自动POST/停止/删除/重算/模型或定时轮询；用户可刷新只读结果。

本轮只源码，tests零写零跑，不启动record页面或真实用途请求，不部署。必要静态/构建与独立审查证据后续补记，不将源码检查当作真实清理验收。

## 源码结果与检查

现役链：RecordingSheet → PurposeSection → usePurposeChange → record-api 的 getPurposeImpact/changePurpose。GET使用生成operation，POST为读取Location保留原apiFetch Response，body/response仍由生成operation类型拥有；没有第二份后端schema或Start入口。请求在当前标签页sessionStorage保留，关闭标签页不承诺恢复；未知时界面明确要求保留标签页。用session+request_id隔离查询且禁用placeholder跨请求复用；无自动重发或新编号。状态改变后失效原record读缓存，不在UI重写录入状态。

本机 api-contracts、api-client、api-client-usage、capability-boundaries、architecture-deepening、learner-copy、typecheck、lint、build均exit0；最后的拒绝重试guard与文案修正后再次typecheck/lint/build通过。新增/修改6源码文件Biome无诊断；全仓lint有168 warnings，未增加allowlist或改baseline。tests零写零跑，未启动页面或用途请求，浏览器/实际stop/repair/delete/provider/部署NOT_RUN。

证据目录：`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/yuk1473/record-purpose-20261030/`，checks.json及final/记录首次门。首次独立审查发现卸载旧实例的迟到响应能覆盖新请求恢复记录（astra-r1.md）。修复将发送前保存、成功及拒绝写回统一为同步核对持久槽后写入：UUID与完整body、Location、resolution必须仍等于该次写入的预期记录；不匹配或无法读取时不覆盖，保留现有记录并停止当前实例的后续命令。旧实例完成时以其原attempt核对，不能用新记录取得写权。原槽为空才可从空状态写入；替换旧已完成请求仍核对原快照。只在持久写入成功后发布本实例的成功回执。

修复后 capability-boundaries、architecture-deepening、learner-copy、typecheck、lint、build 全部 exit0（p1-fix/checks.json），单文件 Biome 与 diff check 通过；唯一修复验证审待完成。未新增或运行测试，未进行请求乱序运行复现，源码不是运行验收。后续问题继续原1473/1522，不新建重复任务。
