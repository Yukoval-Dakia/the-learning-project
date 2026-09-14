# AI Pipeline Architecture - The Learning Project

## Overview

This document visualizes the AI pipeline architecture of The Learning Project, a self-hosted learning system with sophisticated AI task orchestration.

## Architecture Diagram

```mermaid
flowchart TB
    subgraph Client["Client Layer"]
        SPA[Vite SPA<br/>React 19 + TanStack Router]
    end

    subgraph API["API Layer - Hono :8787"]
        direction TB
        Auth[x-internal-token<br/>Auth Middleware]
        Router[Capability Router<br/>manifest.ts composition]
        
        subgraph Capabilities["9 Capability Packages"]
            direction LR
            Practice[Practice<br/>判分/复习/变式]
            Copilot[Copilot<br/>对话/教学]
            Ingestion[Ingestion<br/>OCR/录入]
            Knowledge[Knowledge<br/>图谱/边]
            Notes[Notes<br/>笔记/Artifact]
            Agency[Agency<br/>编排/目标]
            Observability[Observability<br/>监控/成本]
            Onboarding[Onboarding<br/>冷启动]
            Shell[Shell<br/>工作台]
        end
    end

    subgraph Worker["Worker Process - pg-boss"]
        direction TB
        Boss[pg-boss<br/>Job Queue]
        
        subgraph Jobs["Job Handlers"]
            direction LR
            OCR[tencent_ocr_extract]
            QuizGen[quiz_gen]
            VariantGen[variant_gen]
            JudgeRun[judge_run]
            NoteGen[note_generate]
            Nightly[Nightly Jobs<br/>embed/recalibration/kt]
        end
    end

    subgraph AI["AI Task Layer"]
        direction TB
        Runner[Claude Agent SDK Runner<br/>runner.ts]
        Registry[Task Registry<br/>task-catalog.ts<br/>51 TaskSpecs]
        MCP[MCP Bridge<br/>in-process tools]
        
        subgraph Providers["Providers"]
            Mimo[Xiaomi MiMo<br/>mimo-v2.5-pro]
            Anthropic[Anthropic<br/>Opus 4.8]
        end
    end

    subgraph Data["Data Layer"]
        PG[(PostgreSQL<br/>+ pgvector)]
        R2[(R2/S3<br/>Blob Storage)]
    end

    subgraph External["External Services"]
        Tencent[Tencent OCR<br/>QuestionMarkAgent]
        Tavily[Tavily Search]
    end

    %% Flow connections
    SPA -->|HTTP/SSE| Auth
    Auth --> Router
    Router --> Capabilities
    
    Capabilities -->|enqueue| Boss
    Boss --> Jobs
    
    Capabilities -->|runTask/streamTask| Runner
    Jobs -->|runTask/streamTask| Runner
    
    Runner --> Registry
    Runner --> MCP
    Runner --> Providers
    
    Jobs -->|OCR| Tencent
    Jobs -->|Search| Tavily
    
    Capabilities --> PG
    Jobs --> PG
    Runner --> PG
    
    Capabilities --> R2
    Jobs --> R2

    %% Styling
    classDef client fill:#e1f5fe,stroke:#01579b
    classDef api fill:#f3e5f5,stroke:#4a148c
    classDef worker fill:#fff3e0,stroke:#e65100
    classDef ai fill:#e8f5e9,stroke:#1b5e20
    classDef data fill:#fce4ec,stroke:#880e4f
    classDef external fill:#fff8e1,stroke:#ff6f00
    
    class SPA client
    class Auth,Router,Capabilities api
    class Boss,Jobs worker
    class Runner,Registry,MCP,Providers ai
    class PG,R2 data
    class Tencent,Tavily external
```

## Key Components

### 1. Task Registry (51 TaskSpecs)

The central `task-catalog.ts` composes TaskSpecs from 6 capability owner maps:

| Capability | Task Count | Examples |
|------------|------------|----------|
| Practice | 19 | AttributionTask, VariantGenTask, JudgeTasks |
| Notes | 3 | NoteGenerateTask, NoteVerifyTask |
| Ingestion | 8 | VisionExtractTask, StructureTask, TaggingTask |
| Knowledge | 3 | KnowledgeEdgeProposeTask, KnowledgeReviewTask |
| Agency | 13 | DreamingTask, CoachTask, MindModelInductionTask |
| Copilot | 5 | CopilotTask, CopilotDispatchTask, EvidenceReviewTasks |

### 2. Execution Flow

```
User Action → Capability Route → Task Runner → Provider
                     ↓
              pg-boss Job → Task Runner → Provider
```

### 3. Tool Calling Architecture

- **DomainTool Registry**: Static assembly from capability manifests
- **MCP Bridge**: In-process MCP server for Claude Agent SDK
- **Tool Effects**: `read` | `propose` | `write` (write requires user accept)

### 4. Cost & Observability

- Every AI call writes to `ai_task_runs` + `ai_cost_ledger`
- Tool calls logged to `tool_call_log`
- Provider admission control with `provider_attempt` lifecycle

## Evidence

- `src/ai/task-catalog.ts` - Task composition root
- `src/server/ai/runner.ts` - Claude Agent SDK adapter
- `src/capabilities/*/manifest.ts` - Capability declarations
- `docs/architecture.md` - §5 AI Task Layer
