# SubjectProfile Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract current hardcoded wenyan assumptions from AI task prompts into an internal `SubjectProfile` layer, preserve existing wenyan behavior, and add a math profile as a pressure-test fixture.

**Architecture:** Keep AI task registry metadata backward-compatible while moving subject-specific prompt text into profile-aware prompt builders. Domain orchestrators resolve a profile from existing `knowledge.domain` values and pass it into the AI runner through `RunTaskCtx.subjectProfile`.

**Tech Stack:** TypeScript, Next.js App Router server code, Vitest, Drizzle/Postgres test helpers.

---

- [x] Add failing tests for profile resolution and prompt generation.
- [x] Add failing runner test proving `RunTaskCtx.subjectProfile` changes the SDK `systemPrompt` while default behavior stays wenyan.
- [x] Add failing domain wiring tests for note generation, learning intent, teaching, and variant generation.
- [x] Implement `src/subjects/profile.ts`, `src/subjects/wenyan/profile.ts`, and `src/subjects/math/profile.ts`.
- [x] Implement `src/ai/task-prompts.ts` and route supported task prompts through profiles.
- [x] Update `src/ai/registry.ts` so `systemPrompt` remains a default wenyan string.
- [x] Update `src/server/ai/runner.ts` to use the profile-aware task prompt at runtime.
- [x] Wire profile resolution through `note_generate`, `learning_intent`, `teaching`, and `variant_gen`.
- [x] Run targeted tests, `pnpm typecheck`, `pnpm lint`, and `pnpm audit:schema`.

Out of scope for this slice: UI subject switching, DB schema changes, Domain Tool Registry, full JudgeRouter execution, math seed curriculum, and public math learning flows.
