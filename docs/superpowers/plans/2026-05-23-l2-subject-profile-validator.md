# L2 Subject Profile Validator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close YUK-7 and YUK-8 by wiring the existing `SubjectProfileSchema` and `validateProfile()` into build-time audit, runtime subject registration, and the pre-PR test gate.

**Architecture:** Keep `validateProfile()` as the single semantic validator. Move profile schema/type declarations into a dependency-light module so `SubjectRegistry.register()` can call the validator without creating an import cycle.

**Tech Stack:** TypeScript, Zod, Vitest, pnpm, Biome.

**Spec Source:** `docs/superpowers/plans/2026-05-23-track2-and-foundation-closeout-phases.md` L2 plus Linear YUK-7 and YUK-8.

---

## Task 1: Add Build-Time Audit

**Files:**
- Create: `scripts/audit-profile.ts`
- Create: `scripts/audit-profile.test.ts`

- [x] Add an audit function that iterates `subjectProfiles`, calls `validateProfile(profile, getDefaultRegistry())`, and returns structured per-profile results.
- [x] Add CLI output with human-readable failures and `--json` support.
- [x] Cover built-in success, unknown judge capability, duplicate cause id, and missing `promptFragments`.

---

## Task 2: Add Runtime Registration Validation

**Files:**
- Create: `src/subjects/profile-schema.ts`
- Modify: `src/subjects/profile.ts`
- Modify: `src/core/capability/validate-profile.ts`
- Modify: `tests/subjects/profile.test.ts`

- [x] Move profile schema/type exports into `profile-schema.ts`.
- [x] Re-export the same public API from `profile.ts` so existing imports keep working.
- [x] Call `validateProfile()` inside `SubjectRegistry.register()` before storing a profile.
- [x] Add startup-path tests for invalid custom profile registration.

---

## Task 3: Wire Pre-PR Gate

**Files:**
- Modify: `package.json`
- Modify: `CLAUDE.md`

- [x] Add `pnpm audit:profile`.
- [x] Run `pnpm audit:profile` at the start of `pnpm test`.
- [x] Document the command and add it to the pre-PR checklist.

---

## Task 4: Verification

**Commands:**
- [x] `pnpm biome check package.json CLAUDE.md scripts/audit-profile.ts scripts/audit-profile.test.ts src/subjects/profile.ts src/subjects/profile-schema.ts src/core/capability/validate-profile.ts tests/subjects/profile.test.ts docs/superpowers/plans/2026-05-23-l2-subject-profile-validator.md`
- [x] `pnpm audit:profile`
- [x] `pnpm exec vitest run --config vitest.unit.config.ts scripts/audit-profile.test.ts tests/subjects/profile.test.ts tests/core/capability/validate-profile.test.ts`
- [x] `pnpm typecheck`
- [x] `pnpm lint`
- [x] `pnpm test`
