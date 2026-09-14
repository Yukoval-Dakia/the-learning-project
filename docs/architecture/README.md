# AI Pipeline Architecture Summary

## Generated Artifacts

| Artifact | Path | Description |
|----------|------|-------------|
| AI Pipeline Doc | `docs/architecture/ai-pipeline.md` | Mermaid diagram + detailed explanation |
| OpenCode Comparison | `docs/architecture/opencode-comparison.md` | Side-by-side comparison |
| AI Pipeline DOT | `docs/architecture/ai-pipeline.dot` | Graphviz source for Qoder Canvas |
| OpenCode DOT | `docs/architecture/opencode-architecture.dot` | Graphviz source |
| Comparison DOT | `docs/architecture/comparison.dot` | Side-by-side comparison |

## The Learning Project AI Pipeline

### Architecture Characteristics

1. **Multi-Process Design**
   - Hono API server (:8787) - HTTP/SSE endpoints
   - pg-boss Worker - Background job processing
   - Shared PostgreSQL database

2. **Task-Based AI Orchestration**
   - 51 typed TaskSpecs across 6 capability owners
   - Explicit input/output schemas with Zod
   - Budget controls (maxIterations, maxCost, timeout)

3. **Tool System**
   - DomainTool Registry with typed contracts
   - In-process MCP Bridge for Claude Agent SDK
   - Effect-based permissions: read / propose / write

4. **Provider Abstraction**
   - Primary: Xiaomi MiMo (mimo-v2.5-pro)
   - Secondary: Anthropic Opus 4.8 (subscription)
   - Per-call provider override support

5. **Data & Observability**
   - PostgreSQL + pgvector for embeddings
   - Event sourcing (event table as action log)
   - ai_task_runs + ai_cost_ledger for cost tracking
   - R2/S3 for blob storage

### Key Flows

**Synchronous (User-Triggered)**:
```
User → API Route → Capability → Task Runner → Provider → Response
```

**Asynchronous (Background)**:
```
Trigger → pg-boss Job → Task Runner → Provider → Event/DB Write
```

**Tool Calling**:
```
Task Runner → MCP Bridge → DomainTool → Database/Service
```

## OpenCode Architecture

### Architecture Characteristics

1. **Single Server Design**
   - HTTP API server
   - SQLite for session state
   - File system for workspace

2. **Session-Based Model**
   - Conversation-centric
   - Tool calls within session context
   - Plugin-provided tools

3. **Plugin System**
   - npm-based plugins
   - MCP server support
   - Worktree management

4. **Provider Support**
   - Claude (Anthropic)
   - OpenAI (GPT-4)
   - Local models (Ollama/LMStudio)

## Key Differences

| Aspect | The Learning Project | OpenCode |
|--------|---------------------|----------|
| **Primary Use Case** | Learning/Education | Coding Assistant |
| **AI Model** | Task-based (51 types) | Session-based |
| **State** | PostgreSQL + Events | SQLite |
| **Jobs** | pg-boss queue | In-process |
| **Tools** | DomainTool Registry | Plugin Tools |
| **Multi-modal** | Vision OCR, Images | Text-focused |
| **Cost Tracking** | Detailed ledger | Basic |

## Evidence Sources

- `src/ai/task-catalog.ts` - Task composition
- `src/server/ai/runner.ts` - Claude Agent SDK adapter
- `src/capabilities/*/manifest.ts` - Capability declarations
- `.opencode/plugins/worktree.ts` - OpenCode plugin example
- `docs/architecture.md` - §5 AI Task Layer

## Next Steps

1. View diagrams in Qoder Canvas by opening the `.dot` files
2. Review the detailed markdown documentation
3. Explore specific capability implementations in `src/capabilities/`
