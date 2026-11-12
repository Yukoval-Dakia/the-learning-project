CREATE TABLE "subject_doc" (
	"subject_id" text NOT NULL,
	"doc_key" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"body" text NOT NULL,
	"origin" text NOT NULL,
	"seed_version" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "subject_doc_subject_id_doc_key_pk" PRIMARY KEY("subject_id","doc_key")
);
--> statement-breakpoint
CREATE TABLE "subject_doc_journal" (
	"subject_id" text NOT NULL,
	"doc_key" text NOT NULL,
	"revision" integer NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"body" text NOT NULL,
	"seed_version" text,
	"action" text NOT NULL,
	"actor" text NOT NULL,
	"detail" jsonb NOT NULL,
	"change_seq" bigint DEFAULT nextval('subject_change_seq') NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "subject_doc_journal_subject_id_doc_key_revision_pk" PRIMARY KEY("subject_id","doc_key","revision")
);
