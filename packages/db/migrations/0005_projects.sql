CREATE SCHEMA "projects";
--> statement-breakpoint
CREATE TABLE "projects"."project_key_sequences" (
	"project_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"next_value" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "project_key_sequences_project_id_entity_type_pk" PRIMARY KEY("project_id","entity_type")
);
--> statement-breakpoint
CREATE TABLE "projects"."projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text NOT NULL,
	"template_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "projects_key_format" CHECK ("projects"."projects"."key" ~ '^[A-Z][A-Z0-9]{1,9}$'),
	CONSTRAINT "projects_status_valid" CHECK ("projects"."projects"."status" in ('draft', 'active', 'archived', 'deleted'))
);
--> statement-breakpoint
ALTER TABLE "projects"."project_key_sequences" ADD CONSTRAINT "project_key_sequences_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_org_key_ux" ON "projects"."projects" USING btree ("org_id","key");