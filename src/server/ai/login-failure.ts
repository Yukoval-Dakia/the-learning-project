// Typed login/auth failure classification — the single seam consumers
// (drawing's waiting_login pause, admission's login recovery) consult instead
// of matching error strings. Evidence is structural only:
//   - a ChatGPTOAuthFileError anywhere on the error/cause chain (credential
//     store or mid-run refresh), or
//   - a bound HTTP 401 on an api_error_result terminal.
// Anything else returns undefined — the caller fails as an ordinary error,
// never guesses "login" from message text.

import { AgentRunError, type LoginFailureEvidence } from '@/ai/agent-run-error';
import { ChatGPTOAuthFileError } from './chatgpt-oauth-store';

const MAX_CAUSE_DEPTH = 8;

export function classifyLoginFailure(error: unknown): LoginFailureEvidence | undefined {
  if (error instanceof AgentRunError) {
    if (error.loginFailure) return error.loginFailure;
    if (error.subtype === 'api_error_result' && error.apiErrorStatus === 401)
      return { kind: 'provider_auth' };
    const bound = error.providerFailure?.http_status;
    if (bound === 401) return { kind: 'provider_auth' };
  }
  let cursor: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (cursor instanceof ChatGPTOAuthFileError)
      return { kind: 'credential', reason: cursor.reason };
    cursor = cursor instanceof Error ? cursor.cause : undefined;
    if (cursor === undefined || cursor === null) return undefined;
    if (cursor instanceof AgentRunError) {
      if (cursor.loginFailure) return cursor.loginFailure;
      if (cursor.subtype === 'api_error_result' && cursor.apiErrorStatus === 401)
        return { kind: 'provider_auth' };
    }
  }
  return undefined;
}
