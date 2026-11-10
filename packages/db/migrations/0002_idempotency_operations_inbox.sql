CREATE TABLE "platform"."idempotency_keys" (
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text NOT NULL,
	"response_status" integer,
	"response" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_keys_scope_key_pk" PRIMARY KEY("scope","key")
);
--> statement-breakpoint
CREATE TABLE "platform"."inbox_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"dedupe_key" text NOT NULL,
	"event_type" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"verification" text NOT NULL,
	"headers" jsonb NOT NULL,
	"body_ref" text,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "platform"."operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"result_ref" text,
	"error" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform"."probes" ADD COLUMN "operation_id" uuid;--> statement-breakpoint
CREATE INDEX "idempotency_expires_ix" ON "platform"."idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_connection_dedupe_ux" ON "platform"."inbox_messages" USING btree ("connection_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "inbox_pending_ix" ON "platform"."inbox_messages" USING btree ("received_at") WHERE "platform"."inbox_messages"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "operations_project_ix" ON "platform"."operations" USING btree ("project_id","created_at");