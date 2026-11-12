CREATE TABLE "integrations"."sync_cursors" (
	"binding_id" uuid NOT NULL,
	"stream" text NOT NULL,
	"cursor" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sync_cursors_binding_id_stream_pk" PRIMARY KEY("binding_id","stream")
);
--> statement-breakpoint
CREATE TABLE "integrations"."sync_errors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sync_run_id" uuid NOT NULL,
	"external_id" text,
	"kind" text NOT NULL,
	"message" text NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrations"."sync_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"binding_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"stream" text NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"pages" integer DEFAULT 0 NOT NULL,
	"items_seen" integer DEFAULT 0 NOT NULL,
	"items_changed" integer DEFAULT 0 NOT NULL,
	"error_kind" text,
	"retry_after_ms" integer
);
--> statement-breakpoint
ALTER TABLE "integrations"."sync_errors" ADD CONSTRAINT "sync_errors_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "integrations"."sync_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_errors_run_ix" ON "integrations"."sync_errors" USING btree ("sync_run_id");--> statement-breakpoint
CREATE INDEX "sync_runs_binding_ix" ON "integrations"."sync_runs" USING btree ("binding_id","started_at");--> statement-breakpoint
CREATE INDEX "sync_runs_connection_ix" ON "integrations"."sync_runs" USING btree ("connection_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_runs_one_running_ux" ON "integrations"."sync_runs" USING btree ("binding_id","stream") WHERE "integrations"."sync_runs"."status" = 'running';