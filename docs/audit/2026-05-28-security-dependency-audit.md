# Security & Dependency Audit Report

**Date**: 2026-05-28  
**Scope**: Full codebase — Yukoval-Dakia/the-learning-project  
**Method**: 10 parallel Devin sessions, each covering a distinct audit dimension  
**Audited commit**: `5c242f12f09456711caccf5663829250f36ff367` (short: `5c242f1`, branch: main)

---

## Executive Summary

| Severity | Count |
|----------|-------|
| Critical | 1 |
| High | 16 |
| Moderate | 22 |
| Low | 12 |
| Info | 10 |

> **统计口径说明**：表中 Severity 为本次全审计（10 个维度）的发现总数，同一问题被多个维度独立发现时会去重；文中提及的 "9 vulnerabilities" 仅指 `pnpm audit` 输出的漏洞数量，两者口径不同。

**Top risk**: `mem0ai@3.0.4` is the single largest source of vulnerability exposure — 7 of the 9 npm audit findings trace back to its transitive dependency tree (undici, protobufjs, uuid). The package also has low weekly downloads (87K) and a ~58 MB transitive footprint for a 1.8 MB SDK.

**Key positive findings**:
- No hardcoded secrets or API keys in codebase or git history
- Drizzle ORM parameterized queries used throughout — no SQL injection in standard paths
- Proper `.gitignore` / `.dockerignore` coverage
- Zod validation adopted in 33+ route files
- Multi-stage Docker build with non-root user (UID 1001)
- No eval(), Function(), prototype pollution, or command injection patterns found

---

## 1. npm Vulnerability Scan

> [Session](https://app.devin.ai/sessions/ca1c571a3c3a4161bf1638a96eca58a9)

`pnpm audit` found **9 vulnerabilities** across 7 unique packages: 3 high, 5 moderate, 1 low.

### High

| Package | CVE | CVSS | Description | Via |
|---------|-----|------|-------------|-----|
| undici@5.28.5/5.29.0 | CVE-2026-1526 | 7.5 | WebSocket decompression bomb — unbounded memory consumption | testcontainers, mem0ai→@qdrant/js-client-rest |
| undici@5.28.5/5.29.0 | CVE-2026-2229 | 7.5 | WebSocket unhandled exception via invalid `server_max_window_bits` | testcontainers, mem0ai→@qdrant/js-client-rest |
| tmp@0.2.5 | CVE-2026-44705 | — | Path traversal via unsanitized prefix/postfix | testcontainers |

### Moderate

| Package | CVE / GHSA | Description | Via |
|---------|-----------|-------------|-----|
| esbuild@0.18.20/0.21.5 | GHSA-67mh-4wv8-2f99 | Dev server CORS wildcard allows data exfiltration | drizzle-kit, vitest→vite |
| undici@5.28.5/5.29.0 | CVE-2026-22036 | Unbounded decompression chain in HTTP responses | testcontainers, mem0ai |
| undici@5.28.5/5.29.0 | CVE-2026-1525 | HTTP Request/Response smuggling | testcontainers, mem0ai |
| undici@5.28.5/5.29.0 | CVE-2026-43088 | CRLF injection via malicious `host` header | testcontainers, mem0ai |
| postcss@8.4.31 | GHSA-qx2v-qp2m-jg93 | XSS via unescaped `</style>` in CSS stringify | next@15.5.18 (bundled) |

### Recommended pnpm overrides

```jsonc
// package.json → "pnpm": { "overrides": { ... } }
{
  "undici": ">=6.24.0",
  "tmp": ">=0.2.6",
  "protobufjs": ">=7.5.8",
  "uuid": ">=11.1.1"
}
```

---

## 2. Outdated Dependencies

> [Session](https://app.devin.ai/sessions/5c52193da38a42b39ab017a9067710b7)

**29 outdated packages** found. 12 major version behind, 7 minor, 10 patch.

### Major version upgrades needed (high priority)

| Package | Current | Latest | Notes |
|---------|---------|--------|-------|
| next | 15.5.18 | 16.2.6 | Core framework — breaking changes |
| zod | 3.25.76 | 4.4.3 | Pervasive validation — affects drizzle-zod |
| typescript | 5.9.3 | 6.0.3 | Dev dependency |
| vitest | 2.1.9 | 4.1.7 | 2 majors behind — dev |
| @vitest/coverage-v8 | 2.1.9 | 4.1.7 | Must match vitest — dev |
| @biomejs/biome | 1.9.4 | 2.4.16 | Dev — new default rules |
| @paralleldrive/cuid2 | 2.3.1 | 3.3.0 | Check ID format compatibility |
| testcontainers | 10.28.0 | 12.0.1 | 2 majors — dev |
| @testcontainers/postgresql | 10.28.0 | 12.0.1 | 2 majors — dev |
| @types/node | 22.19.18 | 25.9.1 | 3 majors — match runtime Node |
| react-markdown | 9.1.0 | 10.1.0 | |
| lucide-react | 0.468.0 | 1.17.0 | |

### Minor / Patch (quick wins)

| Package | Current | Latest |
|---------|---------|--------|
| @ai-sdk/anthropic | 3.0.76 | 3.0.80 |
| @anthropic-ai/sdk | 0.96.0 | 0.99.0 |
| @anthropic-ai/claude-agent-sdk | 0.3.143 | 0.3.153 |
| @aws-sdk/client-s3 | 3.1045.0 | 3.1055.0 |
| @tanstack/react-query | 5.100.9 | 5.100.14 |
| ai | 6.0.176 | 6.0.191 |
| drizzle-zod | 0.7.1 | 0.8.3 |
| fflate | 0.8.2 | 0.8.3 |
| katex | 0.16.47 | 0.17.0 |
| mem0ai | 3.0.4 | 3.0.5 |
| pg | 8.20.0 | 8.21.0 |
| tailwindcss | 4.2.4 | 4.3.0 |
| tencentcloud-sdk-nodejs-ocr | 4.1.229 | 4.1.233 |
| ts-fsrs | 5.3.2 | 5.4.1 |
| tsx | 4.22.0 | 4.22.3 |
| zustand | 5.0.13 | 5.0.14 |

---

## 3. License Compliance

> [Session](https://app.devin.ai/sessions/4c4fa1d3ba8d4504a591a87dc54ae2a5)

**51 direct packages scanned. No copyleft (GPL/AGPL/LGPL) licenses found.**

| License | Count (prod) | Count (dev) |
|---------|-------------|-------------|
| MIT | 21 | 14 |
| Apache-2.0 | 9 | 1 |
| ISC | 1 | — |
| BSD-2-Clause | — | 1 |
| MIT OR Apache-2.0 | — | 1 |
| Unlicense | 1 (postgres) | — |
| Custom/Proprietary | 1 (@anthropic-ai/claude-agent-sdk) | — |

### Action items

- **@anthropic-ai/claude-agent-sdk** — proprietary Anthropic license ("SEE LICENSE IN README.md"). Review [Anthropic Commercial Terms](https://www.anthropic.com/legal/commercial-terms) to confirm usage rights.
- All other production dependencies use permissive licenses — no compliance risk.

---

## 4. Docker & Container Security

> [Session](https://app.devin.ai/sessions/73143542eae44a0189a00126047a9d68)

### Positives
- Multi-stage build minimizes final image
- Non-root user (nextjs:nodejs, UID 1001)
- No secrets in build args
- Network isolation via internal bridge
- Postgres healthcheck configured

### Findings

| Severity | Finding | Component |
|----------|---------|-----------|
| High | `pgvector/pgvector:pg16` — unpinned floating tag; surprise pg17 bump would break pgdata | docker-compose.yml |
| High | `cloudflare/cloudflared:latest` — unpinned mutable tag | docker-compose.yml |
| Moderate | Default Postgres credentials `loom:loom` | docker-compose.yml, .env.example |
| Moderate | TUNNEL_TOKEN as plain env var (visible in `docker inspect`) | docker-compose.yml |
| Moderate | All 8+ secrets via `env_file`, not Docker secrets | docker-compose.yml |
| Moderate | No HEALTHCHECK for app/worker containers | Dockerfile |
| Low | `node:24-bookworm-slim` — floating major version tag | Dockerfile |
| Low | No resource limits (memory, CPU) | docker-compose.yml |
| Low | No security hardening (cap_drop, no-new-privileges, read_only) | docker-compose.yml |
| Low | No log rotation configured | docker-compose.yml |
| Low | docker-compose.local.yml exposes port 5433 to host | docker-compose.local.yml |

### Recommended image pins

```yaml
postgres:
  image: pgvector/pgvector:0.8.2-pg16-bookworm

cloudflared:
  image: cloudflare/cloudflared:2026.5.2
```

---

## 5. API Endpoint Security

> [Session](https://app.devin.ai/sessions/af914877823140e9b2cc9259ad53dc74)

### Positives
- All `/api/*` routes behind `x-internal-token` (except `/api/health`)
- Zod validation widely adopted (33+ route files)
- Drizzle ORM parameterized queries prevent SQL injection in all standard paths
- No SSRF or path traversal vectors found

### Findings

| Severity | Finding | Component |
|----------|---------|-----------|
| High | `errorResponse()` leaks raw `Error.message` to clients for 500 errors | `src/server/http/errors.ts` |
| High | `/api/health` leaks DB error details (publicly accessible, no auth) | `app/api/health/route.ts` |
| Moderate | No rate limiting on any endpoint — AI routes could burn API credits | All `/api/*` routes |
| Moderate | AI runner uses `bypassPermissions` with user-controlled prompt input | `src/server/ai/runner.ts` |
| Moderate | `sql.raw()` in archive restore uses column names from imported ZIP data | `src/server/export/archive.ts` |
| Low | Timing-unsafe token comparison (`===` instead of `timingSafeEqual`) | `middleware.ts` |
| Low | No request size limits configured | Next.js config |
| Low | Copilot chat allows self-referencing system prompt via user message | `src/server/copilot/chat.ts` |

---

## 6. Secrets & Environment Exposure

> [Session](https://app.devin.ai/sessions/4edb3e0fb0074430b83127d77fa08f0a)

### Positives
- No hardcoded real API keys, passwords, or tokens in codebase
- No `.env` files ever committed to git history
- Most env vars have fail-fast validation at startup
- `next.config.ts` has no secret exposure via `NEXT_PUBLIC_`

### Findings

| Severity | Finding | Component |
|----------|---------|-----------|
| High | Tencent OCR credentials used without startup validation — silently passes `undefined` | `src/server/ingestion/tencent_mark.ts` |
| Moderate | Default Postgres credentials `loom:loom` in compose + scripts | `docker-compose.yml`, `scripts/local-db-env.ts` |
| Moderate | `INTERNAL_TOKEN='change-me'` placeholder could be used as-is | `.env.local.example`, `middleware.ts` |
| Moderate | `mem0ai` client mutates `process.env.ANTHROPIC_API_KEY` with XIAOMI_API_KEY | `src/server/memory/client.ts` |
| Low | `INTERNAL_TOKEN` stored in localStorage without expiry | `src/ui/lib/api.ts` |
| Low | Dummy `DATABASE_URL` in Dockerfile builder stage | `Dockerfile` |
| Low | Inconsistent env var stubbing in test files | Various test files |

---

## 7. Supply Chain Analysis

> [Session](https://app.devin.ai/sessions/5403536bdfff442f9db8f2f0afc33138)

### Positives
- Lockfile (pnpm-lock v9.0) with 1,078 packages, all with SHA-512 integrity hashes
- No dependency confusion risks — project is private, no custom registry
- No typosquatting detected
- No malicious install scripts (preinstall/postinstall)
- No non-registry sources

### Findings

| Severity | Finding | Component |
|----------|---------|-----------|
| High | `mem0ai@3.0.4` pulls massive transitive tree with 7 vulnerable packages | mem0ai |
| High | Vulnerable undici <6.24.0 via mem0ai and testcontainers (6 CVEs) | undici@5.28.5, undici@5.29.0 |
| High | Vulnerable tmp@0.2.5 — path traversal | testcontainers |
| Moderate | Vulnerable esbuild <0.25.0 in transitive deps (CORS wildcard) | drizzle-kit, vitest→vite |
| Moderate | Vulnerable vite@5.4.21 — path traversal in optimized deps | vitest |
| Moderate | Vulnerable postcss@8.4.31 bundled by next | next@15.5.18 |
| Moderate | Vulnerable protobufjs@7.5.7 — DoS | mem0ai→@google/genai |
| Moderate | Vulnerable uuid@9.0.1/10.0.0 — buffer bounds | mem0ai, testcontainers |
| Low | No Dependabot / Renovate configured for automated dep updates | repo config |
| Low | `mem0ai` is the only exactly-pinned dependency (no `^` / `~`) | package.json |

---

## 8. Code Security Patterns

> [Session](https://app.devin.ai/sessions/8c2d039314844999b74fc0965b3f0560)

### Positives
- All DB queries use Drizzle ORM parameterized `sql` tagged templates
- No `eval()`, `Function()`, prototype pollution, or command injection
- AI output parsing uses `JSON.parse` + Zod schema validation consistently
- File system operations restricted to test infrastructure
- `dangerouslySetInnerHTML` in `app/layout.tsx` uses static constant (safe)

### Findings

| Severity | Finding | Component |
|----------|---------|-----------|
| Moderate | `errorResponse()` leaks raw error messages to API clients | `src/server/http/errors.ts` |
| Moderate | Column names from untrusted ZIP interpolated into `sql.raw()` | `src/server/export/archive.ts` |
| Low | `dangerouslySetInnerHTML` in design prototypes with data-derived content | `docs/design/loom-design-v2*/pages.jsx` |
| Low | DB error details exposed in restore failure response | `src/server/export/archive.ts` |

---

## 9. Next.js Security Configuration

> [Session](https://app.devin.ai/sessions/5c7546202704420e88efd54a8dfaffef)

### Findings

| Severity | Finding | Component |
|----------|---------|-----------|
| High | No security response headers (CSP, X-Frame-Options, HSTS, etc.) | `next.config.ts` |
| High | Timing-unsafe token comparison (`===`) | `middleware.ts` |
| Moderate | Middleware only protects `/api/*` — page routes publicly accessible | `middleware.ts` |
| Moderate | `X-Powered-By: Next.js` header not disabled | `next.config.ts` |
| Moderate | No `images.remotePatterns` configured (future SSRF risk) | `next.config.ts` |
| Low | `INTERNAL_TOKEN` stored in localStorage (client-side) | `src/ui/lib/api.ts` |
| Low | No `server-only` package used to enforce server/client boundary | Various server modules |

### Recommended next.config.ts additions

```typescript
const nextConfig: NextConfig = {
  poweredByHeader: false,
  images: { remotePatterns: [] },
  async headers() {
    return [{
      source: "/(.*)",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ],
    }];
  },
};
```

---

## 10. Dependency Deep Analysis

> [Session](https://app.devin.ai/sessions/241549b14a1740d0abde0036597f70ac)

**Total**: 33 direct prod deps, ~905 total packages, 1.7 GB node_modules.

### Critical dependency health

| Package | Current → Latest | Downloads/wk | Maintainers | Status |
|---------|-----------------|--------------|-------------|--------|
| pg | 8.20.0 → 8.21.0 | 29.3M | 1 (brianc) | ✓ Healthy |
| postgres | 3.4.9 (latest) | 9.2M | 1 (porsager) | ✓ Healthy |
| pg-boss | 12.18.2 (latest) | 645K | 1 (timjones) | ✓ Healthy |
| drizzle-orm | 0.45.2 (latest) | 9.6M | 4 | ✓ Healthy |
| @anthropic-ai/sdk | 0.96.0 → 0.99.0 | 20.8M | 14 | ✓ Healthy |
| @aws-sdk/client-s3 | 3.1045.0 → 3.1055.0 | 28.2M | AWS | ✓ Healthy |
| sharp | 0.34.5 (latest) | 65.3M | 1 (lovell) | ✓ Healthy |
| next | 15.5.18 → 16.2.6 | 39.7M | Vercel | ⚠ 1 major behind |

### Concerns

| Severity | Finding | Package |
|----------|---------|---------|
| Critical | node_modules = 1.7 GB — dominated by claude-agent-sdk platform binaries (~452 MB) | @anthropic-ai/claude-agent-sdk |
| High | mem0ai: 87K downloads, 3 maintainers, ~58 MB transitive deps, 7 CVEs | mem0ai@3.0.4 |
| High | claude-agent-sdk ships ~452 MB of linux-x64 + linux-x64-musl binaries | @anthropic-ai/claude-agent-sdk@0.3.143 |
| Moderate | next@15.5.18 one major behind; earlier 15.x had CVE-2025-66478 | next |
| Moderate | Dual Postgres drivers (pg + postgres) increase connection surface | pg, postgres |
| Moderate | tencentcloud-sdk-nodejs-ocr: only 1.5K weekly downloads | tencentcloud-sdk-nodejs-ocr |
| Low | ts-fsrs: 52K downloads, single maintainer — bus factor risk | ts-fsrs@5.3.2 |
| Low | katex 0.16→0.17 minor upgrade includes security-related fixes | katex |

---

## Priority Action Plan

### Immediate (this sprint)

1. **Add pnpm overrides** for `undici>=6.24.0`, `tmp>=0.2.6`, `protobufjs>=7.5.8`, `uuid>=11.1.1`
2. **Fix error leakage**: Return generic message in `errorResponse()` for non-ApiError exceptions
3. **Fix /api/health**: Remove `db_error` details from public response
4. **Add security headers** in `next.config.ts` (CSP, X-Frame-Options, nosniff, etc.)
5. **Set `poweredByHeader: false`** in `next.config.ts`
6. **Use `crypto.timingSafeEqual()`** for token comparison in `middleware.ts`

### Short-term (next 2 weeks)

7. **Upgrade mem0ai** to 3.0.5+; evaluate if lighter Mem0 API integration is feasible
8. **Pin Docker image tags**: `pgvector:0.8.2-pg16-bookworm`, `cloudflared:2026.5.2`
9. **Add rate limiting** to AI-invoking API routes
10. **Validate Tencent OCR credentials** at startup (fail-fast)
11. **Validate archive column names** against Drizzle schema in `archive.ts`
12. **Add container healthchecks** for app and worker services
13. **Upgrade patch/minor deps**: @anthropic-ai/sdk, @aws-sdk/client-s3, pg, mem0ai, etc.

### Medium-term (next month)

14. **Plan Next.js 16 migration** (major version upgrade)
15. **Upgrade Vitest 2→4** + @vitest/coverage-v8
16. **Upgrade Biome 1→2**
17. **Evaluate claude-agent-sdk binary size** — use `supportedArchitectures` to skip unused platform
18. **Configure Renovate/Dependabot** for automated dependency update PRs
19. **Migrate Docker secrets** from env_file to Docker secrets for production
20. **Add container resource limits** and security hardening (cap_drop, no-new-privileges)

### Low priority

21. Update Zod 3→4 (widespread impact, needs careful migration)
22. Update TypeScript 5→6
23. Add `server-only` package for boundary enforcement
24. Review @anthropic-ai/claude-agent-sdk proprietary license terms

---

## Appendix: Child Session Links

| # | Audit Area | Session |
|---|-----------|---------|
| 1 | npm Vulnerability Scan | [ca1c571a](https://app.devin.ai/sessions/ca1c571a3c3a4161bf1638a96eca58a9) |
| 2 | Outdated Dependencies | [5c52193d](https://app.devin.ai/sessions/5c52193da38a42b39ab017a9067710b7) |
| 3 | License Compliance | [4c4fa1d3](https://app.devin.ai/sessions/4c4fa1d3ba8d4504a591a87dc54ae2a5) |
| 4 | Docker & Container Security | [73143542](https://app.devin.ai/sessions/73143542eae44a0189a00126047a9d68) |
| 5 | API Endpoint Security | [af914877](https://app.devin.ai/sessions/af914877823140e9b2cc9259ad53dc74) |
| 6 | Secrets & Environment Exposure | [4edb3e0f](https://app.devin.ai/sessions/4edb3e0fb0074430b83127d77fa08f0a) |
| 7 | Supply Chain Analysis | [5403536b](https://app.devin.ai/sessions/5403536bdfff442f9db8f2f0afc33138) |
| 8 | Code Security Patterns | [8c2d0393](https://app.devin.ai/sessions/8c2d039314844999b74fc0965b3f0560) |
| 9 | Next.js Security Configuration | [5c754620](https://app.devin.ai/sessions/5c7546202704420e88efd54a8dfaffef) |
| 10 | Dependency Deep Analysis | [241549b1](https://app.devin.ai/sessions/241549b14a1740d0abde0036597f70ac) |
