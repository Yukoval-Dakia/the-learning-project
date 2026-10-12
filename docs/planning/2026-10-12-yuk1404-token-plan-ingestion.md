# DOCX 轻量录入：Token Plan 接线与材料验收边界

2026-10-12，接续 dfe9b1b3 / Draft #1703。用户选择已有 Token Plan，并在获知个人套餐官方用途限制后确认自己账户可用；这不是厂商豁免证据。服务端若拒绝权限/用途即停止，不绕过、不更换身份、不回退按量或余额。本轮不访问账户页面、不接受新条款、不改凭证/生产配置。

## 实际接线与免费预检

- 云环境 `XIAOMI_TOKEN_PLAN_API_KEY`、`ZHIPU_API_KEY` 均存在；未打印值。当前进程原路由为 opencode-go/mimo-v2.6-pro；未修改它。
- 一次性预检子进程用现有 resolver 选择 `xiaomi-token-plan/mimo-v2.6-pro`，得到 `https://token-plan-cn.xiaomimimo.com/v1`、openai-completions、text/image、contextWindow1048576。应用现有 capability binding 确认 toolCalling/vision，离线 case 不再注入能力声明。凭证是否有效、账户套餐类型/剩额尚未通过真实请求或账户读取得到证明。
- TaskSpec 默认改为该既有 Token Plan 组合；补齐 owned-task-specs 已有 provider 校验表遗漏的一项。全局 env pin 的优先级保持不变；其他实际绑定会被 DOCX 闸门拒绝，绝不自行 fallback。真实验收仅在独立进程选择目标组合，不写生产配置。

## 保留与简化

保留原 DOCX/转换副本/全文 Markdown/嵌图/渲染 PDF/页面图与稳定 asset/page/block ID；已生成材料复用。保留现有 list/text/image/region 读取与 inspect/upsert/check/commit、原有 edit/merge/figure 工具、session 隔离、版本检查、canonical 草稿和失败恢复。完整性要求每个来源归到题树/共享材料、非题目或 unresolved，不以“看过页面”替代完整性；手写作答不当标准答案。

删除 DOCX 活跃路径的海外 USD approval、美元价卡准入、跨任务周账聚合和全局预算锁。旧 `docx_request_budget` 与历史证据不删除、不改写。当前仅记录本任务 Token Plan 请求/用量，保留通用 runner 的窄 request guard 与日志 owner，不造计费框架。

不安装 Docling、不增加解析器或懒生成框架。现有 PDFium 有 page.getText()，后续 PDF 原生文本可直接复用；当前独立 PDF 上传路由仍以渲染页为主，不能声称已经完成全文/原件保全改造。本轮不扩 PDF 路由或 OCR 工具。

## 本次硬限制与计量

仅现有 `xiaomi-token-plan/mimo-v2.6-pro`、三个官方专用区域端点、openai-completions/1048576窗口可进入请求。每 run 最多16模型请求、24工具、4096输出tokens（包含reasoning）、240秒；SDK与任务重试0。最终payload强制max_completion_tokens，禁止native paid search与额外choices。

按[官方套餐规则](https://mimo.mi.com/docs/en-US/price/token-plan)：v2.6-pro输入非缓存300、缓存2.5、输出600 credits/token。每请求先预留全窗口非缓存输入加4096输出，即 **317030400 credits**；整窗口包含图片/工具历史，不使用每图估算上限。每 run **650000000 credits** 封顶，调用前检查“已结算保守用量+新全额预留”，有效usage释放差额。未知/中断持久保留全额并终止本run，不能记零。

保存 provider 观察到的 input/output/cache tokens；credits是依照套餐规则计算的估计，不能称为账户账单实扣。另存带来源日期的目录USD折算上界，供父任务计入原周20USD预算；650M credits保守约等于$0.9425目录值，不是现金支出，也不是账户剩额。缓存按非缓存计入准入更保守，真实用量估计单独保留缓存规则。没有跨账户周账保障，旧ledger/provider_attempt缺口由父任务对账，不在本路径扩框架。

[套餐说明](https://mimo.mi.com/docs/zh-CN/tokenplan/Token%20Plan/subscription)写明额度耗尽会停止服务，不继续扣账户余额；应用也没有 fallback。它同时限制个人版用途；用户的账户许可确认不改变官方说明，套餐类型未在本轮核实。

## GLM OCR：复用，但本轮不调用

`glm_ocr.ts` 已用 `ZHIPU_API_KEY` 经 Bearer 访问 `https://open.bigmodel.cn/api/paas/v4/layout_parsing`，model=glm-ocr，单页同步请求。已有 request ID、tokens、provider attempt与CNY费用估算；当前代码按输入输出均¥0.2/M估值。OCR独立计费，不能当Token Plan免费项目。当前未确认原单页成本阈值及可用周剩额，仍停在付费前。

父任务核实的[当前API说明](https://docs.bigmodel.cn/api-reference/模型-api/文档解析.md)描述bbox_2d为0–1；仓库真实fixture契约却是absolute pixels，image块允许缺content。本轮不盲改适配器；首次获准真实OCR应保留原始响应、页面尺寸和请求ID，核实坐标约定后再归一化交给agent。全文可读时先不用OCR。

## 验收现状与下一次真实输入

只更新一条既有DB case：真实runner/Pi agentLoop/PG/材料owner，provider响应受控；两次图片请求额外通过真实SDK序列化与内存fetch。按量端点0次stream，未知用量第8次后留额，图片run第10次后因650M上限拒绝下一次，两草稿保存；恢复后partial、正式0/draft2/ignored0。共27受控stream、2内存fetch、0真实provider/OCR请求。证据见 `evidence/2026-10-12-yuk1404-token-plan-offline.json`。

用户最新指定 `Desktop/test-data`，原“两页四题合成真实调用”已取消，未消费真实调用次数。Mac任务正在核目录/新增zip的最小样本及敏感性；云端等待选定文件，不上传整个目录、不改原文件、不先跑合成再重复收费。本次真实调用最多一个task，失败不连续重跑、不静默降级；保全原件和分阶段证据。分别记录完整提取、图片引用、题型/选项、草稿确认、正式入库、可答题状态；答案/判分准入保持独立。
