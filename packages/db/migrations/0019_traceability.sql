CREATE SCHEMA "traceability";
--> statement-breakpoint
CREATE TABLE "traceability"."traceability_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"type" text NOT NULL,
	"from_type" text NOT NULL,
	"from_id" uuid NOT NULL,
	"from_version_id" uuid,
	"to_type" text NOT NULL,
	"to_id" uuid NOT NULL,
	"to_version_id" uuid,
	"ac_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"review_reason" jsonb,
	"origin" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "traceability_links_status_ck" CHECK ("traceability"."traceability_links"."status" in ('active', 'outdated', 'removed')),
	CONSTRAINT "traceability_links_origin_ck" CHECK ("traceability"."traceability_links"."origin" in ('user', 'ai', 'system'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "traceability_links_edge_ux" ON "traceability"."traceability_links" USING btree ("project_id","type","from_type","from_id","to_type","to_id") WHERE "traceability"."traceability_links"."status" <> 'removed';--> statement-breakpoint
CREATE INDEX "traceability_links_to_ix" ON "traceability"."traceability_links" USING btree ("to_type","to_id","type","status");--> statement-breakpoint
CREATE INDEX "traceability_links_from_ix" ON "traceability"."traceability_links" USING btree ("from_type","from_id","type","status");--> statement-breakpoint
CREATE INDEX "traceability_links_project_ix" ON "traceability"."traceability_links" USING btree ("project_id","type","status");