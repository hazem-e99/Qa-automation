-- Hand-written migration: extensions, the partitioned append-only audit log, and the outbox wake-up trigger.
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS citext;
--> statement-breakpoint
CREATE SCHEMA "governance";
--> statement-breakpoint
CREATE TABLE "governance"."audit_events" (
	"id" uuid NOT NULL,
	"org_id" uuid,
	"project_id" uuid,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"summary" jsonb NOT NULL,
	"source" text NOT NULL,
	"ip" inet,
	"ua" text,
	"correlation_id" text,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "audit_events_pk" PRIMARY KEY ("id", "created_at")
) PARTITION BY RANGE ("created_at");
--> statement-breakpoint
CREATE TABLE "governance"."audit_events_default" PARTITION OF "governance"."audit_events" DEFAULT;
--> statement-breakpoint
CREATE INDEX "audit_events_target_ix" ON "governance"."audit_events" ("target_type", "target_id", "created_at");
--> statement-breakpoint
CREATE INDEX "audit_events_project_ix" ON "governance"."audit_events" ("project_id", "created_at");
--> statement-breakpoint
CREATE FUNCTION "governance"."ensure_audit_partition"(month_start date) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
	from_ts date := date_trunc('month', month_start)::date;
	to_ts date := (date_trunc('month', month_start) + interval '1 month')::date;
	part_name text := 'audit_events_' || to_char(from_ts, 'YYYY_MM');
BEGIN
	IF to_regclass('governance.' || quote_ident(part_name)) IS NULL THEN
		EXECUTE format(
			'CREATE TABLE governance.%I PARTITION OF governance.audit_events FOR VALUES FROM (%L) TO (%L)',
			part_name, from_ts, to_ts
		);
	END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "governance"."audit_events_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'governance.audit_events is append-only (% is not allowed)', TG_OP
		USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "audit_events_no_update_delete"
	BEFORE UPDATE OR DELETE ON "governance"."audit_events"
	FOR EACH ROW EXECUTE FUNCTION "governance"."audit_events_immutable"();
--> statement-breakpoint
CREATE FUNCTION "platform"."outbox_notify"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	PERFORM pg_notify('qos_outbox', '');
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "outbox_events_notify"
	AFTER INSERT ON "platform"."outbox_events"
	FOR EACH STATEMENT EXECUTE FUNCTION "platform"."outbox_notify"();
