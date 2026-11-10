CREATE SCHEMA "platform";
--> statement-breakpoint
CREATE TABLE "platform"."outbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid,
	"type" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"correlation_id" text,
	"dispatched_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "platform"."probes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone,
	"event_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "outbox_undispatched_ix" ON "platform"."outbox_events" USING btree ("occurred_at") WHERE "platform"."outbox_events"."dispatched_at" is null;