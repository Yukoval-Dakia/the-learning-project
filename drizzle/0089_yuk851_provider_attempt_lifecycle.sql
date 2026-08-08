CREATE TABLE "provider_attempt" (
  "attempt_id" uuid PRIMARY KEY,
  "operation_id" uuid NOT NULL,
  "attempt_kind" text NOT NULL,
  "provider" text NOT NULL,
  "model" text,
  "lane_id" text NOT NULL,
  "protocol" text NOT NULL,
  "endpoint_class" text NOT NULL,
  "caller" text NOT NULL,
  "operation_kind" text NOT NULL,
  "external_request_id" text,
  "terminal_status" text,
  "terminal_reason" text,
  "wire_count" integer,
  "usage_json" jsonb,
  "cost_basis" text,
  "cost_amount" double precision,
  "cost_currency" text,
  "cost_source" text,
  "started_at" timestamp with time zone NOT NULL,
  "provider_start_reserved_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  CONSTRAINT "provider_attempt_kind_ck"
    CHECK ("attempt_kind" IN ('wire', 'opaque_operation')),
  CONSTRAINT "provider_attempt_caller_ck"
    CHECK ("caller" IN ('api', 'worker')),
  CONSTRAINT "provider_attempt_terminal_ck"
    CHECK ("terminal_status" IS NULL OR "terminal_status" IN ('succeeded', 'failed', 'aborted', 'unknown')),
  CONSTRAINT "provider_attempt_identity_ck"
    CHECK (
      btrim("provider") <> ''
      AND ("model" IS NULL OR btrim("model") <> '')
      AND btrim("lane_id") <> ''
      AND btrim("protocol") <> ''
      AND btrim("endpoint_class") <> ''
      AND btrim("operation_kind") <> ''
      AND ("external_request_id" IS NULL OR btrim("external_request_id") <> '')
    ),
  CONSTRAINT "provider_attempt_wire_ck"
    CHECK ("wire_count" IS NULL OR "wire_count" >= 0),
  CONSTRAINT "provider_attempt_opaque_ck"
    CHECK ("attempt_kind" <> 'opaque_operation' OR "wire_count" IS NULL),
  CONSTRAINT "provider_attempt_terminal_shape_ck"
    CHECK (
      (
        "finished_at" IS NULL
        AND "terminal_status" IS NULL
        AND "terminal_reason" IS NULL
        AND "wire_count" IS NULL
        AND "usage_json" IS NULL
        AND "cost_basis" IS NULL
        AND "cost_amount" IS NULL
        AND "cost_currency" IS NULL
        AND "cost_source" IS NULL
      ) OR (
        "finished_at" IS NOT NULL
        AND "terminal_status" IS NOT NULL
        AND "terminal_reason" IS NOT NULL
        AND btrim("terminal_reason") <> ''
        AND "usage_json" IS NOT NULL
        AND jsonb_typeof("usage_json") = 'object'
        AND "usage_json" ?& ARRAY['basis','unit','input','output','total','source']
        AND "usage_json" - ARRAY['basis','unit','input','output','total','source']::text[] = '{}'::jsonb
        AND jsonb_typeof("usage_json"->'source') = 'string'
        AND btrim("usage_json"->>'source') <> ''
        AND (
          (
            "usage_json"->>'basis' IN ('reported','estimated')
            AND jsonb_typeof("usage_json"->'unit') = 'string'
            AND btrim("usage_json"->>'unit') <> ''
            AND jsonb_typeof("usage_json"->'input') IN ('number','null')
            AND jsonb_typeof("usage_json"->'output') IN ('number','null')
            AND jsonb_typeof("usage_json"->'total') IN ('number','null')
            AND (
              jsonb_typeof("usage_json"->'input') = 'number'
              OR jsonb_typeof("usage_json"->'output') = 'number'
              OR jsonb_typeof("usage_json"->'total') = 'number'
            )
            AND COALESCE(("usage_json"->>'input')::double precision, 0) >= 0
            AND COALESCE(("usage_json"->>'output')::double precision, 0) >= 0
            AND COALESCE(("usage_json"->>'total')::double precision, 0) >= 0
          ) OR (
            "usage_json"->>'basis' = 'unknown'
            AND (
              jsonb_typeof("usage_json"->'unit') = 'null'
              OR (jsonb_typeof("usage_json"->'unit') = 'string' AND btrim("usage_json"->>'unit') <> '')
            )
            AND jsonb_typeof("usage_json"->'input') = 'null'
            AND jsonb_typeof("usage_json"->'output') = 'null'
            AND jsonb_typeof("usage_json"->'total') = 'null'
          )
        )
        AND "cost_basis" IS NOT NULL
        AND "cost_source" IS NOT NULL
      )
    ),
  CONSTRAINT "provider_attempt_cost_shape_ck"
    CHECK (
      "cost_basis" IS NULL OR (
        btrim("cost_source") <> ''
        AND (
          (
            "cost_basis" IN ('reported', 'estimated')
            AND "cost_amount" IS NOT NULL
            AND "cost_amount" NOT IN ('Infinity'::double precision, '-Infinity'::double precision, 'NaN'::double precision)
            AND "cost_amount" >= 0
            AND "cost_currency" ~ '^[A-Z]{3}$'
          ) OR (
            "cost_basis" = 'unknown'
            AND "cost_amount" IS NULL
            AND ("cost_currency" IS NULL OR "cost_currency" ~ '^[A-Z]{3}$')
          )
        )
      )
    ),
  CONSTRAINT "provider_attempt_timeline_ck"
    CHECK (
      ("provider_start_reserved_at" IS NULL OR "provider_start_reserved_at" >= "started_at")
      AND ("finished_at" IS NULL OR "finished_at" >= "started_at")
      AND ("finished_at" IS NULL OR "provider_start_reserved_at" IS NULL
        OR "finished_at" >= "provider_start_reserved_at")
    )
);

CREATE INDEX "provider_attempt_operation_idx"
  ON "provider_attempt" ("operation_id", "started_at" DESC, "attempt_id");
CREATE INDEX "provider_attempt_open_operation_idx"
  ON "provider_attempt" ("operation_id", "lane_id", "started_at" DESC)
  WHERE "finished_at" IS NULL;
CREATE INDEX "provider_attempt_external_request_idx"
  ON "provider_attempt" ("provider", "external_request_id")
  WHERE "external_request_id" IS NOT NULL;

CREATE TABLE "provider_attempt_admission" (
  "attempt_id" uuid PRIMARY KEY,
  "identity_fingerprint" text NOT NULL,
  "policy_fingerprint" text NOT NULL,
  "lane_id" text NOT NULL,
  "mode" text NOT NULL,
  "status" text NOT NULL,
  "lease_owner" uuid,
  "requested_at" timestamp with time zone NOT NULL,
  "deadline_at" timestamp with time zone NOT NULL,
  "acquired_at" timestamp with time zone,
  "lease_expires_at" timestamp with time zone,
  "terminal_at" timestamp with time zone,
  "terminal_reason" text,
  CONSTRAINT "provider_attempt_admission_identity_ck"
    CHECK (
      btrim("identity_fingerprint") <> ''
      AND btrim("policy_fingerprint") <> ''
      AND btrim("lane_id") <> ''
      AND "mode" IN ('observe', 'enforce')
      AND "status" IN ('acquired', 'would_deny', 'denied', 'released', 'lease_expired')
    ),
  CONSTRAINT "provider_attempt_admission_state_ck"
    CHECK (
      (
        "status" IN ('acquired', 'would_deny')
        AND "lease_owner" IS NOT NULL
        AND "acquired_at" IS NOT NULL
        AND "lease_expires_at" IS NOT NULL
        AND "terminal_at" IS NULL
        AND "terminal_reason" IS NULL
        AND (
          ("status" = 'acquired' AND "lease_expires_at" <= "deadline_at")
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
    )
);

CREATE INDEX "provider_attempt_admission_lane_active_idx"
  ON "provider_attempt_admission" ("lane_id", "lease_expires_at", "attempt_id")
  WHERE "status" IN ('acquired', 'would_deny');
CREATE INDEX "provider_attempt_admission_lane_start_idx"
  ON "provider_attempt_admission" ("lane_id", "acquired_at", "attempt_id")
  WHERE "acquired_at" IS NOT NULL;
CREATE INDEX "provider_attempt_admission_lane_terminal_idx"
  ON "provider_attempt_admission" ("lane_id", "terminal_at", "attempt_id")
  WHERE "terminal_at" IS NOT NULL;
