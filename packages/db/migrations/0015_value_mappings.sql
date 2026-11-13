CREATE TABLE "integrations"."value_mappings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"entries" jsonb NOT NULL,
	"discovered" jsonb,
	"discovered_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "value_mappings_binding_kind_ux" ON "integrations"."value_mappings" USING btree ("binding_id","kind");--> statement-breakpoint
CREATE INDEX "value_mappings_project_ix" ON "integrations"."value_mappings" USING btree ("project_id");