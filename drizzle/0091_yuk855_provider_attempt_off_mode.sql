ALTER TABLE "provider_attempt_admission"
  DROP CONSTRAINT "provider_attempt_admission_identity_ck";
--> statement-breakpoint
ALTER TABLE "provider_attempt_admission"
  ADD CONSTRAINT "provider_attempt_admission_identity_ck"
  CHECK (
    btrim("identity_fingerprint") <> ''
    AND btrim("policy_fingerprint") <> ''
    AND btrim("lane_id") <> ''
    AND "mode" IN ('off', 'observe', 'enforce')
    AND "status" IN ('acquired', 'would_deny', 'denied', 'released', 'lease_expired')
  );
--> statement-breakpoint
ALTER TABLE "provider_attempt_admission"
  DROP CONSTRAINT "provider_attempt_admission_state_ck";
--> statement-breakpoint
ALTER TABLE "provider_attempt_admission"
  ADD CONSTRAINT "provider_attempt_admission_state_ck"
  CHECK (
    (
      "status" IN ('acquired', 'would_deny')
      AND "lease_owner" IS NOT NULL
      AND "acquired_at" IS NOT NULL
      AND "lease_expires_at" IS NOT NULL
      AND "terminal_at" IS NULL
      AND "terminal_reason" IS NULL
      AND (
        (
          "status" = 'acquired'
          AND ("mode" = 'off' OR "lease_expires_at" <= "deadline_at")
        )
        OR ("status" = 'would_deny' AND "mode" = 'observe')
      )
    ) OR (
      "status" = 'denied'
      AND "lease_owner" IS NULL
      AND "mode" = 'enforce'
      AND "acquired_at" IS NULL
      AND "lease_expires_at" IS NULL
      AND "terminal_at" IS NOT NULL
      AND "terminal_reason" IS NOT NULL
      AND btrim("terminal_reason") <> ''
    ) OR (
      "status" IN ('released', 'lease_expired')
      AND "lease_owner" IS NOT NULL
      AND "acquired_at" IS NOT NULL
      AND "lease_expires_at" IS NOT NULL
      AND "terminal_at" IS NOT NULL
      AND "terminal_reason" IS NOT NULL
      AND btrim("terminal_reason") <> ''
      AND ("status" = 'released' OR "terminal_at" >= "lease_expires_at")
    )
  );
