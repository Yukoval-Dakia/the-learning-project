# Domain Documentation Configuration

This project uses a **single-context** layout.

## Layout

- **Context file**: `CONTEXT.md` at repo root — 领域术语表（领域专家视角的术语，不收纯实现概念）
- **ADR directory**: `docs/adr/` at repo root — ADR 以四位编号 `NNNN-<slug>.md` 依次存放（0001 起，仅缺 0009）；无索引文件，直接读目录，数量以目录为准。ADR-0014 记录 generalized activity / capability registry 的基础决策（部分 facet 已被后续 ADR 修订）

## Consumer Rules

Skills that read domain documentation should:

1. Read `CONTEXT.md` to understand the project's domain language, key concepts, and terminology
2. Read ADRs from `docs/adr/` to understand past architectural decisions before proposing changes
3. Use this context to inform code generation, refactoring suggestions, and architectural improvements
4. Respect the established domain language when suggesting changes — 不要用旧术语（如 "mistake"），改用 CONTEXT.md 的当前术语（如 "错题 / event WHERE action='attempt' AND outcome='failure'"）
5. 当对话中出现新术语或既有术语需要修订时，**就地**更新 CONTEXT.md，不要批量留到事后（这条规则继承自 CONTEXT.md 自身的开头说明）

## Related Documentation

The project also maintains:

- `docs/architecture.md` — 纯实现层架构（pg-boss、SSE、jsonb schema 等），与 CONTEXT.md 互补
- `docs/modules/` — 各业务模块文档（knowledge / lanes / learning-items / memory / mistakes / notes / progress / quiz / records）
- `docs/design/` — 设计与决策草稿
- `docs/planning/` — 版本规划（v0.X）
- `docs/audit/` — 漂移审计输出（`/audit-drift` skill 写入）
- `docs/agents/objectives.md` — Copilot / Coach / Dreaming / Maintenance 四个 agent + 窄任务（共五节速查卡）的运行期 objective 速查卡（形态设计记录在 [ADR-0076](../adr/0076-agent-framework-product-shape.md)）
