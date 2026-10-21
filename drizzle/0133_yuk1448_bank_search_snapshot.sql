-- YUK-1448: short-lived server-owned semantic search pagination; no gap or issuance authority.
CREATE TABLE "bank_search_snapshot" (
  "search_id" uuid PRIMARY KEY NOT NULL,
  "actor_key" text NOT NULL,
  "read_role" text NOT NULL,
  "request_digest" text NOT NULL,
  "result_digest" text NOT NULL,
  "payload" jsonb NOT NULL,
  "as_of" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  CONSTRAINT "bank_search_snapshot_role_ck" CHECK ("read_role" IN ('owner','private','restricted')),
  CONSTRAINT "bank_search_snapshot_digest_ck" CHECK ("request_digest" ~ '^[a-f0-9]{64}$' AND "result_digest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "bank_search_snapshot_ttl_ck" CHECK ("expires_at" > "as_of" AND "expires_at" <= "as_of" + interval '15 minutes')
);
--> statement-breakpoint
CREATE INDEX "bank_search_snapshot_expiry_idx" ON "bank_search_snapshot" ("expires_at");
