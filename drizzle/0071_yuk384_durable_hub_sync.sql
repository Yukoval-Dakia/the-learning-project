CREATE TABLE "artifact_edit_session" (
	"artifact_id" text NOT NULL,
	"session_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_edit_session_pkey" PRIMARY KEY("artifact_id","session_id")
);
--> statement-breakpoint
CREATE TABLE "hub_sync_reconciliation" (
	"artifact_id" text PRIMARY KEY NOT NULL,
	"actor_ref" text DEFAULT 'hub_auto_sync' NOT NULL,
	"generation" bigint DEFAULT 1 NOT NULL,
	"acknowledged_generation" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"claim_owner" text,
	"claim_token" text,
	"lease_expires_at" timestamp with time zone,
	"claim_count" integer DEFAULT 0 NOT NULL,
	"consecutive_failure_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_dirty_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_claimed_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"last_outcome" text,
	"last_error_class" text,
	"last_error_code" text,
	"last_error" text,
	"last_desired_hash" text,
	"last_repair_key" text,
	"last_observed_artifact_version" integer,
	"last_applied_artifact_version" integer,
	CONSTRAINT "hub_sync_actor_check" CHECK ("hub_sync_reconciliation"."actor_ref" = 'hub_auto_sync'),
	CONSTRAINT "hub_sync_generation_check" CHECK ("hub_sync_reconciliation"."generation" > 0),
	CONSTRAINT "hub_sync_ack_generation_check" CHECK ("hub_sync_reconciliation"."acknowledged_generation" >= 0 and "hub_sync_reconciliation"."acknowledged_generation" <= "hub_sync_reconciliation"."generation"),
	CONSTRAINT "hub_sync_status_check" CHECK ("hub_sync_reconciliation"."status" in ('pending','claimed','applying','retry_wait','acknowledged','cancelled')),
	CONSTRAINT "hub_sync_claim_shape_check" CHECK ((("hub_sync_reconciliation"."status" in ('claimed','applying')) = ("hub_sync_reconciliation"."claim_owner" is not null and "hub_sync_reconciliation"."claim_token" is not null and "hub_sync_reconciliation"."lease_expires_at" is not null)))
);
--> statement-breakpoint
ALTER TABLE "artifact_edit_session" ADD CONSTRAINT "artifact_edit_session_artifact_id_artifact_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_sync_reconciliation" ADD CONSTRAINT "hub_sync_reconciliation_artifact_id_artifact_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- YUK-384 — durable hub-sync partial/covering indexes. clock_timestamp() is kept
-- OUT of every partial-index predicate (predicates reference stored columns only)
-- so the indexes stay immutable and usable by the planner.
CREATE INDEX "hub_sync_ready_idx" ON "hub_sync_reconciliation" ("next_attempt_at", "last_dirty_at", "artifact_id")
  WHERE "status" IN ('pending', 'retry_wait');--> statement-breakpoint
CREATE INDEX "hub_sync_expired_idx" ON "hub_sync_reconciliation" ("lease_expires_at", "artifact_id")
  WHERE "status" IN ('claimed', 'applying');--> statement-breakpoint
CREATE INDEX "hub_sync_dirty_age_idx" ON "hub_sync_reconciliation" ("last_dirty_at", "artifact_id")
  WHERE "acknowledged_generation" < "generation";--> statement-breakpoint
CREATE INDEX "artifact_edit_session_recent_idx" ON "artifact_edit_session" ("artifact_id", "last_heartbeat_at" DESC);--> statement-breakpoint
-- mark_hub_sync_dirty(artifact_id, cancel): atomically advance ONE hub's durable
-- reconciliation generation. New rows land at generation 1; conflicts bump the
-- generation by one, reset the claim/lease/failure/error state, and set status to
-- 'cancelled' (archive/type-loss) or 'pending' (create/restore/relevant change).
CREATE OR REPLACE FUNCTION "mark_hub_sync_dirty"(target_artifact_id text, cancel_target boolean)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO hub_sync_reconciliation (
    artifact_id, generation, status, next_attempt_at, last_dirty_at, updated_at,
    claim_owner, claim_token, lease_expires_at, consecutive_failure_count,
    last_error_at, last_error_class, last_error_code, last_error
  )
  VALUES (
    target_artifact_id, 1, CASE WHEN cancel_target THEN 'cancelled' ELSE 'pending' END,
    clock_timestamp(), clock_timestamp(), clock_timestamp(),
    NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL
  )
  ON CONFLICT (artifact_id) DO UPDATE SET
    generation = hub_sync_reconciliation.generation + 1,
    status = CASE WHEN cancel_target THEN 'cancelled' ELSE 'pending' END,
    next_attempt_at = clock_timestamp(),
    last_dirty_at = clock_timestamp(),
    updated_at = clock_timestamp(),
    claim_owner = NULL,
    claim_token = NULL,
    lease_expires_at = NULL,
    consecutive_failure_count = 0,
    last_error_at = NULL,
    last_error_class = NULL,
    last_error_code = NULL,
    last_error = NULL;
END;
$$;--> statement-breakpoint
-- fanout_hub_sync_dirty(): single trigger function on artifact / knowledge /
-- knowledge_edge. Topology-relevant KG changes fan out to EVERY live hub in
-- sorted artifact-id order (deadlock-free); hub-local changes dirty/cancel the
-- one hub; live-atomic changes fan out. The reconciliation-owned body write sets
-- app.hub_sync_internal_apply='1' and MUST NOT self-dirty — only that GUC path
-- suppresses the artifact trigger, and only for the reconciler's own write.
CREATE OR REPLACE FUNCTION "fanout_hub_sync_dirty"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_live_hub boolean;
  new_live_hub boolean;
BEGIN
  IF TG_TABLE_NAME = 'artifact' THEN
    -- The reconciler's own body_blocks/version write must never self-dirty.
    -- Only this GUC (set by hub-sync finalization) reaches here, and the
    -- reconciler touches no other artifact row/column, so a full skip is safe.
    IF current_setting('app.hub_sync_internal_apply', true) = '1' THEN
      RETURN COALESCE(NEW, OLD);
    END IF;

    IF TG_OP = 'INSERT' THEN
      IF NEW.type = 'note_hub' AND NEW.archived_at IS NULL THEN
        PERFORM mark_hub_sync_dirty(NEW.id, false);
      ELSIF NEW.type = 'note_atomic' AND NEW.archived_at IS NULL THEN
        PERFORM mark_hub_sync_dirty(id, false)
        FROM artifact WHERE type = 'note_hub' AND archived_at IS NULL ORDER BY id;
      END IF;
    ELSIF TG_OP = 'UPDATE' THEN
      IF OLD.type = 'note_hub' OR NEW.type = 'note_hub' THEN
        old_live_hub := OLD.type = 'note_hub' AND OLD.archived_at IS NULL;
        new_live_hub := NEW.type = 'note_hub' AND NEW.archived_at IS NULL;
        IF old_live_hub AND NOT new_live_hub THEN
          -- archive or type loss cancels the cursor.
          PERFORM mark_hub_sync_dirty(NEW.id, true);
        ELSIF new_live_hub AND NOT old_live_hub THEN
          -- restore (or type gain) re-dirties the cursor.
          PERFORM mark_hub_sync_dirty(NEW.id, false);
        ELSIF new_live_hub AND old_live_hub AND (
          OLD.knowledge_ids IS DISTINCT FROM NEW.knowledge_ids
          OR OLD.body_blocks IS DISTINCT FROM NEW.body_blocks
          OR OLD.attrs IS DISTINCT FROM NEW.attrs
        ) THEN
          PERFORM mark_hub_sync_dirty(NEW.id, false);
        END IF;
      ELSIF OLD.type = 'note_atomic' OR NEW.type = 'note_atomic' THEN
        IF OLD.title IS DISTINCT FROM NEW.title
          OR OLD.knowledge_ids IS DISTINCT FROM NEW.knowledge_ids
          OR OLD.archived_at IS DISTINCT FROM NEW.archived_at
          OR OLD.type IS DISTINCT FROM NEW.type THEN
          PERFORM mark_hub_sync_dirty(id, false)
          FROM artifact WHERE type = 'note_hub' AND archived_at IS NULL ORDER BY id;
        END IF;
      END IF;
    ELSIF TG_OP = 'DELETE' THEN
      -- Hard-deleted hubs cascade their cursor via FK. A live atomic delete
      -- changes every hub mesh, so fan out.
      IF OLD.type = 'note_atomic' AND OLD.archived_at IS NULL THEN
        PERFORM mark_hub_sync_dirty(id, false)
        FROM artifact WHERE type = 'note_hub' AND archived_at IS NULL ORDER BY id;
      END IF;
    END IF;
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_TABLE_NAME = 'knowledge' THEN
    IF TG_OP = 'INSERT' OR TG_OP = 'DELETE' OR (
      OLD.name IS DISTINCT FROM NEW.name
      OR OLD.domain IS DISTINCT FROM NEW.domain
      OR OLD.parent_id IS DISTINCT FROM NEW.parent_id
      OR OLD.merged_from IS DISTINCT FROM NEW.merged_from
      OR OLD.archived_at IS DISTINCT FROM NEW.archived_at
    ) THEN
      PERFORM mark_hub_sync_dirty(id, false)
      FROM artifact WHERE type = 'note_hub' AND archived_at IS NULL ORDER BY id;
    END IF;
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_TABLE_NAME = 'knowledge_edge' THEN
    IF TG_OP = 'INSERT' OR TG_OP = 'DELETE' OR (
      OLD.from_knowledge_id IS DISTINCT FROM NEW.from_knowledge_id
      OR OLD.to_knowledge_id IS DISTINCT FROM NEW.to_knowledge_id
      OR OLD.relation_type IS DISTINCT FROM NEW.relation_type
      OR OLD.archived_at IS DISTINCT FROM NEW.archived_at
    ) THEN
      PERFORM mark_hub_sync_dirty(id, false)
      FROM artifact WHERE type = 'note_hub' AND archived_at IS NULL ORDER BY id;
    END IF;
    RETURN COALESCE(NEW, OLD);
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;--> statement-breakpoint
CREATE TRIGGER "hub_sync_artifact_dirty"
  AFTER INSERT OR UPDATE OR DELETE ON "artifact"
  FOR EACH ROW EXECUTE FUNCTION "fanout_hub_sync_dirty"();--> statement-breakpoint
CREATE TRIGGER "hub_sync_knowledge_dirty"
  AFTER INSERT OR UPDATE OR DELETE ON "knowledge"
  FOR EACH ROW EXECUTE FUNCTION "fanout_hub_sync_dirty"();--> statement-breakpoint
CREATE TRIGGER "hub_sync_knowledge_edge_dirty"
  AFTER INSERT OR UPDATE OR DELETE ON "knowledge_edge"
  FOR EACH ROW EXECUTE FUNCTION "fanout_hub_sync_dirty"();--> statement-breakpoint
-- Backfill: one 'pending' cursor per already-live hub (generation defaults to 1,
-- acknowledged_generation to 0). ON CONFLICT keeps it idempotent.
INSERT INTO hub_sync_reconciliation (artifact_id, status)
SELECT id, 'pending' FROM artifact
WHERE type = 'note_hub' AND archived_at IS NULL
ORDER BY id
ON CONFLICT (artifact_id) DO NOTHING;
