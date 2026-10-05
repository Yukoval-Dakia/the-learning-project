# Copilot product completion — backend slice, YUK-958

Successful quiz replies now explicitly carry the existing `skill_turn.kind=end`.
No parallel lifecycle enum is introduced. Partial, failed, cancelled and blocked
learning-content replies do not end a mode. Teaching retains its existing
explain/ask_check/end behavior pack; legacy solve is not inferred or extended.

The same skill-turn/context pair is persisted with the domain reply and durable
REPLY/DONE, then read back during redelivery repair and turn replay. Explicit
durable quiz carries its context only in validated job metadata, never in the
assembled model input. Ordinary chat and teaching routing remain compatible.

## Verification

- Author: 124 scoped unit and 88 DB cases; 47 durable handler cases rerun.
- Independent initial review: APPROVE, 117 unit and four targeted durable DB cases.
- Author typecheck/lint/build, Postman generation and architecture/control-plane audits passed.
- Root integration includes YUK-954's hidden-native-terminal settlement correction.
- No paid provider call, new table, production migration, flag flip or deployment.

This slice does **not** remove the client's one-shot workaround or unify UI message
projection. The exact drawer/file preflight remains awaiting owner approval; no
UI file has been changed. YUK-958 remains open until that consumer work is accepted.
Exact-head CI is required before merging this backend slice.
