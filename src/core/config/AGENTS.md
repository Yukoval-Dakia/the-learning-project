# src/core/config — 配置归属

新环境变量先定归属再写代码。产品代码新增裸 `process.env.X` 会被
`pnpm audit:flags --strict` 拒绝（存量只列出）。

## 五张表

`src/core/config/server/env.ts` 的 `BOOT_ENV_OWNERS` 给每个 boot schema 键一个类别；
`audit:flags` 校验它覆盖 schema、`hot` 与 registry envName 逐名相等、`STAY_IN_PLACE_ENV`
不标 hot。

| 类别 | 谁读 / 放哪 | 新增时改什么 |
|---|---|---|
| `hot` | `registry.ts` 登记：DB 行为主，env 是 fallback/pin，15s 快照生效 | registry 定义（description/consumers/reload/exposure）+ env schema + 本表 |
| `boot` | 产品代码在启动、适配器初始化或作业边界读解析后的 env；无 DB 层 | env schema + 本表 |
| `secret` | 凭据/HMAC，owner 是入口或适配器；不进 `system_config`，不下发浏览器 | env schema + 本表 |
| `test` | 只有测试/CI/本机 dev 读 | env schema + 本表 |
| `script` | 只有 `scripts/`、CLI、部署工具读；API 与 worker 不读 | env schema + 本表 |

判定顺序：registry 已登记 → `hot`；凭据/HMAC 且产品代码读 → `secret`；只有
测试/CI/本机 dev → `test`；只有 scripts/CLI/部署读 → `script`；其余产品代码读 → `boot`。

`.env.example` 要列出每个 boot schema 键（不写真实值）；`audit:flags` 报这条漂移，
不改门。加一个 provider key 仍是 3 个文件：`src/server/ai/providers.ts` 的 `apiKeyEnv`、
`src/core/config/server/env.ts`（schema + `BOOT_ENV_OWNERS`）、`.env.example`。

## 读法

- `hot`：`getConfig` / `getConfigFlag` / `getConfigMany`，不读 `process.env`。
- `boot`：读 `createServerEnv()` 的解析结果，不读 `process.env`。
- `secret` / `test` / `script` 的直读要进 `scripts/audit-flags.ts` 的
  `STAY_IN_PLACE_ENV`，写清 owner 和理由；owner 之外的读点会红。

## 还没进表的隐身名（S3 搬）

- `FORGETTING_ENGINE` — `src/kernel/scheduling.ts`；引擎选择，登记后 pinned/restart。
- `QUESTION_ADMISSION_POLICY_ID` — `src/capabilities/practice/question-bank/server/admission/run-admission.ts`。
- `QUESTION_ADMISSION_SOLVER2_PROVIDER` / `QUESTION_ADMISSION_SOLVER2_MODEL` —
  `src/capabilities/practice/question-bank/jobs/question_admission_run.ts`、
  `src/capabilities/practice/question-bank/server/admission/reauthorization.ts`。
  admission 三个进 registry 是 per-call，付费边界保持 fail-closed。

已在 `STAY_IN_PLACE_ENV` 的 4 个隐身名不再另表：`DB_POOL_MAX`（`src/db/pool.ts`）、
`DEV_HOST`（`server/dev-frontdoor.ts`）、`OPENAI_CHATGPT_AUTH_FILE`
（`src/server/ai/pi-models.ts`）、`PLAYWRIGHT_BROWSERS_PATH`
（`src/capabilities/practice/question-bank/server/custom-block-preview/chromium-runner.ts`）。
