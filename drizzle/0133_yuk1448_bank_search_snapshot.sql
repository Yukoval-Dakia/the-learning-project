CREATE TABLE "bank_search_snapshot" (
	"search_id" uuid PRIMARY KEY NOT NULL,
	"actor_key" text NOT NULL,
	"read_role" text NOT NULL,
	"request_digest" text NOT NULL,
	"result_digest" text NOT NULL,
	"payload" jsonb NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "bank_search_snapshot_role_ck" CHECK ("bank_search_snapshot"."read_role" IN ('owner','private','restricted')),
	CONSTRAINT "bank_search_snapshot_digest_ck" CHECK ("bank_search_snapshot"."request_digest" ~ '^[a-f0-9]{64}$' AND "bank_search_snapshot"."result_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "bank_search_snapshot_ttl_ck" CHECK ("bank_search_snapshot"."expires_at" > "bank_search_snapshot"."as_of" AND "bank_search_snapshot"."expires_at" <= "bank_search_snapshot"."as_of" + interval '15 minutes')
);
--> statement-breakpoint
CREATE INDEX "bank_search_snapshot_expiry_idx" ON "bank_search_snapshot" USING btree ("expires_at");