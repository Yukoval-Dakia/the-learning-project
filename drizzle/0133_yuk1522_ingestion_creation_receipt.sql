CREATE TABLE "ingestion_creation_receipt" (
	"actor_ref" text NOT NULL,
	"operation_scope" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"input_version" integer NOT NULL,
	"input_digest" text NOT NULL,
	"response_status" integer NOT NULL,
	"response_body" jsonb NOT NULL,
	"response_location" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingestion_creation_receipt_actor_ref_operation_scope_idempotency_key_pk" PRIMARY KEY("actor_ref","operation_scope","idempotency_key"),
	CONSTRAINT "ingestion_creation_receipt_actor_check" CHECK ("ingestion_creation_receipt"."actor_ref" = 'self'),
	CONSTRAINT "ingestion_creation_receipt_scope_check" CHECK ("ingestion_creation_receipt"."operation_scope" IN ('ingestion_session.create.v1', 'manual_mistake.create.v1'))
);
