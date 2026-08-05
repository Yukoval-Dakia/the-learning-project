-- YUK-842 — cross-process admission for complete provider SDK query sessions.
--
-- This is an operational lease/state table plus a start-reservation ledger. Terminal rows become
-- eligible after seven days for opportunistic lane-local pruning; there is no background TTL.
-- It deliberately measures query sessions, not individual provider wire requests. task_run_id and
-- borrowed_from_task_run_id are loose refs: waiting/timeout records intentionally precede the
-- ai_task_runs row, which is created only after acquire. No FK may couple restore to transient state.
CREATE TABLE "provider_session_admission" (
  "task_run_id" text PRIMARY KEY NOT NULL,
  "lane_id" text NOT NULL,
  "policy_fingerprint" text NOT NULL,
  "mode" text NOT NULL,
  "status" text NOT NULL,
  "borrowed_from_task_run_id" text,
  "claim_token" uuid,
  "requested_at" timestamp with time zone NOT NULL,
  "wait_deadline_at" timestamp with time zone NOT NULL,
  "acquired_at" timestamp with time zone,
  "heartbeat_at" timestamp with time zone,
  "lease_expires_at" timestamp with time zone,
  "hard_reclaim_at" timestamp with time zone,
  "terminal_at" timestamp with time zone,
  "terminal_reason" text,
  CONSTRAINT "provider_session_admission_mode_ck"
    CHECK ("mode" IN ('observe', 'enforce')),
  CONSTRAINT "provider_session_admission_status_ck"
    CHECK ("status" IN (
      'waiting', 'acquired', 'released', 'timed_out', 'cancelled', 'rejected', 'lease_expired'
    )),
  CONSTRAINT "provider_session_admission_identifiers_ck"
    CHECK (
      "task_run_id" = btrim("task_run_id")
      AND "task_run_id" <> ''
      AND "lane_id" = btrim("lane_id")
      AND "lane_id" <> ''
      AND "policy_fingerprint" = btrim("policy_fingerprint")
      AND "policy_fingerprint" <> ''
      AND (
        "borrowed_from_task_run_id" IS NULL
        OR (
          "borrowed_from_task_run_id" = btrim("borrowed_from_task_run_id")
          AND "borrowed_from_task_run_id" <> ''
        )
      )
    ),
  CONSTRAINT "provider_session_admission_acquisition_shape_ck"
    CHECK (
      (
        "claim_token" IS NULL
        AND "acquired_at" IS NULL
        AND "heartbeat_at" IS NULL
        AND "lease_expires_at" IS NULL
        AND "hard_reclaim_at" IS NULL
      ) OR (
        "claim_token" IS NOT NULL
        AND "acquired_at" IS NOT NULL
        AND "heartbeat_at" IS NOT NULL
        AND "lease_expires_at" IS NOT NULL
        AND "hard_reclaim_at" IS NOT NULL
      )
    ),
  CONSTRAINT "provider_session_admission_status_shape_ck"
    CHECK (
      ("status" IN ('waiting', 'timed_out', 'rejected') AND "acquired_at" IS NULL)
      OR ("status" IN ('acquired', 'released', 'lease_expired') AND "acquired_at" IS NOT NULL)
      OR "status" = 'cancelled'
    ),
  CONSTRAINT "provider_session_admission_terminal_shape_ck"
    CHECK (
      (
        "status" IN ('waiting', 'acquired')
        AND "terminal_at" IS NULL
        AND "terminal_reason" IS NULL
      ) OR (
        "status" IN ('released', 'timed_out', 'cancelled', 'rejected', 'lease_expired')
        AND "terminal_at" IS NOT NULL
        AND "terminal_reason" IS NOT NULL
        AND btrim("terminal_reason") <> ''
      )
    ),
  CONSTRAINT "provider_session_admission_borrow_shape_ck"
    CHECK (
      "borrowed_from_task_run_id" IS NULL
      OR (
        "borrowed_from_task_run_id" <> "task_run_id"
        AND "acquired_at" IS NOT NULL
        AND "status" IN ('acquired', 'released', 'cancelled', 'lease_expired')
      )
    ),
  CONSTRAINT "provider_session_admission_timeline_ck"
    CHECK (
      "wait_deadline_at" > "requested_at"
      AND (
        "acquired_at" IS NULL
        OR (
          "acquired_at" >= "requested_at"
          AND "acquired_at" < "wait_deadline_at"
          AND "heartbeat_at" >= "acquired_at"
          AND "lease_expires_at" > "heartbeat_at"
          AND "hard_reclaim_at" >= "lease_expires_at"
        )
      )
      AND (
        "terminal_at" IS NULL
        OR (
          "terminal_at" >= "requested_at"
          AND ("acquired_at" IS NULL OR "terminal_at" >= "acquired_at")
        )
      )
      AND ("status" <> 'timed_out' OR "terminal_at" >= "wait_deadline_at")
      AND ("status" <> 'lease_expired' OR "terminal_at" >= "lease_expires_at")
    )
);

-- A short-lease loss remains quarantined until hard_reclaim_at. One active descendant chain consumes
-- no additional slot while an active ancestor owns the family slot; parallel siblings consume another
-- root or wait. If the ancestor ends first, runtime counts the child. Every child still appears in the
-- independent start-reservation rate index.
CREATE INDEX "provider_session_admission_lane_active_idx"
  ON "provider_session_admission" ("lane_id", "hard_reclaim_at", "borrowed_from_task_run_id")
  WHERE "status" IN ('acquired', 'lease_expired');

CREATE INDEX "provider_session_admission_lane_lease_idx"
  ON "provider_session_admission" ("lane_id", "lease_expires_at")
  WHERE "status" = 'acquired';

CREATE INDEX "provider_session_admission_lane_start_idx"
  ON "provider_session_admission" ("lane_id", "acquired_at")
  WHERE "acquired_at" IS NOT NULL;

CREATE INDEX "provider_session_admission_lane_waiting_idx"
  ON "provider_session_admission" ("lane_id", "requested_at", "task_run_id")
  WHERE "status" = 'waiting';

CREATE INDEX "provider_session_admission_borrowed_from_idx"
  ON "provider_session_admission" ("borrowed_from_task_run_id")
  WHERE "borrowed_from_task_run_id" IS NOT NULL;

-- A later tick for this lane may prune at most 100 terminal rows older than seven days.
CREATE INDEX "provider_session_admission_lane_terminal_idx"
  ON "provider_session_admission" ("lane_id", "terminal_at")
  WHERE "terminal_at" IS NOT NULL;

COMMENT ON TABLE "provider_session_admission" IS
  'Operational provider query-session admission leases and start-reservation ledger with seven-day pruning eligibility; not wire-request accounting';
COMMENT ON COLUMN "provider_session_admission"."borrowed_from_task_run_id" IS
  'Loose ref to an active same-lane parent; only one descendant chain may share a family slot and parallel branches consume roots';
