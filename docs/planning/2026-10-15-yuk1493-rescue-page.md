# 视觉救援使用请求页（YUK-1493）

服务阶段：第一天能用。基线 `1f887ed`；本地产品提交 `a37e4a3`。

## 已确认问题与修复

现役 `VisionTab` 传入题块的零基 `page_index`；OCR job 将按页排列的全部来源
资产存入每个 block。`runRescue` 却固定下载块的第一项资产，仅将请求页码写进
提示词。因此第二页以后仍分析第一页图像。canonical ingestion operation 与
旧 HTTP adapter 都进入该函数。

现在按 ingestion session 的来源页序读取请求页，并确认该资产属于目标块。
不使用块的局部数组推断页序，不在请求无效时回退第一页。已有 session 守卫在
R2/model 调用前检查 `partial/extracted`；最终事务仍再次检查状态和块归属。
写回的结构化结果保留 `runVisionExtract` 用可信请求值覆盖后的 `page_index`。

| 条件 | 修改后的处理（源码审查） |
| --- | --- |
| 页码为 1，session 有按序排列的两张页图 | 读取第二张图，不使用第一张 |
| 非安全整数、负数、越界 | 在下载/模型调用前返回 400 |
| 页资产不在目标块的来源集合中 | 在下载/模型调用前返回 400 |
| session 不存在或不是 ingestion | 返回 404 |
| session 已不可救援 | 既有状态守卫在付费前拒绝 |
| 模型执行期间 session 转终态 | 最终事务仍拒绝写回；不承诺撤销已发生费用 |

## 验证与限制

`pnpm typecheck`、`pnpm lint`（0 errors / 172 existing warnings）、完整
`pnpm build` 均通过。独立初审读取实际 diff、OCR/PDF/DOCX/手动导入消费者，
无引入的 P0/P1。没有新增或修改测试代码。

表格是源码推导，不是实测 HTTP/DB/provider 输出；这些运行验收均 NOT_RUN。
原有同页多题总取模型第一块的问题仍未修。DOCX 文字录入的历史页码占位也未
重建；本修改只修复所请求页的素材映射，不声称自动定位所有 DOCX 题目的真实页。
