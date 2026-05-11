# TypeScript 单语种 + Python sidecar 逃生舱

主仓库保持 TypeScript 单语种（Next.js + Drizzle + AI SDK + pg-boss + ts-fsrs），不引入 Python。背景：这是个人 AI 学习工具，所有 AI / OCR 能力走托管 API（Anthropic、Tencent OCR），FSRS / 知识图谱 / 异步任务用现成 TS 生态完全够；roadmap 上没有需要本地模型权重或 pandas 量级数据处理的任务。

**触发换路径的唯一条件**：出现「需要在本机跑模型权重」或「单次任务需要 pandas/numpy 量级的内存数据处理」时，**新增一个 Python sidecar 容器**（docker-compose 加一个 service，通过 HTTP 或 pg-boss job 与主 app 通讯），而**不是**重写主 app。

这条规则的存在是为了：(a) 阻止每隔几周对单语种选择的重复怀疑；(b) 在真正需要 Python 时给出明确的、最小破坏性的接入方式。
