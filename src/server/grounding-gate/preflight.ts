export function validateShadowProviderEnv(env: NodeJS.ProcessEnv): void {
  const conflicting = ['AI_PROVIDER_OVERRIDE', 'AI_PROVIDER_MODEL'].filter((name) =>
    env[name]?.trim(),
  );
  if (conflicting.length > 0) {
    throw new Error(
      `shadow provider preflight failed: unset ${conflicting.join(', ')} so MindModelInductionTask stays on Opus and ClaimGroupingTask stays on Mimo`,
    );
  }
  const missing = ['CLAUDE_CODE_OAUTH_TOKEN', 'XIAOMI_API_KEY'].filter(
    (name) => !env[name]?.trim(),
  );
  if (missing.length > 0) {
    throw new Error(
      `shadow provider preflight failed: missing ${missing.join(', ')} (values were not printed)`,
    );
  }
}
