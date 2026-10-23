// The 202 acceptance of POST /api/copilot/chat: the stable run handle (Location, or the body's
// run_id rebuilt into the same events URL) and the policy the server accepted. Anything unreadable
// is "acceptance unknown": the caller keeps the exact request so a recovery replays it.

import { DerivationPolicy, type DerivationPolicyT } from '@/core/schema/derivation-policy';
import { durableRunIdFromLocation } from '../durable-reconnect-storage';

/** The server may tighten answer_only to crisis (YUK-1398); both honour the restriction. */
const RESTRICTED_ACCEPTED_POLICIES: ReadonlySet<string> = new Set(['answer_only', 'crisis']);

export class AcceptanceUnknownError extends Error {}

/** Read the 202: the stable run handle and the policy the server accepted. */
export async function readAcceptance(
  res: Response,
  requested: DerivationPolicyT | undefined,
): Promise<{ runId: string; location: string; policy: DerivationPolicyT }> {
  if (res.status !== 202) throw new AcceptanceUnknownError(`acceptance status ${res.status}`);
  let policy: DerivationPolicyT = 'allow';
  let body: unknown;
  let bodyRunId: string | undefined;
  try {
    body = await res.json();
  } catch {
    // Legacy allow responses recover through Location and the server snapshot.
  }
  if (body !== null && typeof body === 'object') {
    if ('run_id' in body && typeof body.run_id === 'string') bodyRunId = body.run_id;
    if ('derivation_policy' in body) {
      const parsed = DerivationPolicy.safeParse(body.derivation_policy);
      if (!parsed.success) throw new AcceptanceUnknownError('accepted policy unreadable');
      policy = parsed.data;
    }
  }
  if (requested === 'answer_only' && !RESTRICTED_ACCEPTED_POLICIES.has(policy)) {
    throw new AcceptanceUnknownError('accepted policy not restricted');
  }
  let location = res.headers.get('Location');
  let runId = durableRunIdFromLocation(location);
  if (!runId && bodyRunId) {
    const rebuilt = `/api/jobs/copilot_run/${encodeURIComponent(bodyRunId)}/events`;
    if (durableRunIdFromLocation(rebuilt) === bodyRunId) {
      runId = bodyRunId;
      location = rebuilt;
    }
  }
  if (!runId || !location) throw new AcceptanceUnknownError('accepted without a stable handle');
  return { runId, location, policy };
}
