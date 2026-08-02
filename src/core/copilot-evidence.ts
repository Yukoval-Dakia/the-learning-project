/**
 * The FULL evidence contract must be able to name every DomainTool call that a
 * durable Copilot run can execute. Keep the validator schema and durable
 * anti-runaway ceiling on this shared value.
 */
export const COPILOT_EVIDENCE_MAX_TRACE_CALLS = 60;
