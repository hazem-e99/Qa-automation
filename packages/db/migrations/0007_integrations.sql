CREATE SCHEMA "integrations";
--> statement-breakpoint
CREATE TABLE "integrations"."connection_capabilities" (
	"connection_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"ok" boolean NOT NULL,
	"detail" text,
	CONSTRAINT "connection_capabilities_connection_id_capability_pk" PRIMARY KEY("connection_id","capability")
);
--> statement-breakpoint
CREATE TABLE "integrations"."connection_checks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"ok" boolean NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrations"."connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"provider_type" text NOT NULL,
	"family" text NOT NULL,
	"display_name" text NOT NULL,
	"base_url" text,
	"external_instance" text,
	"auth_strategy" text NOT NULL,
	"secret_ref" text,
	"status" text NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"last_tested_at" timestamp with time zone,
	"credential_expires_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrations"."external_refs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid,
	"connection_id" uuid NOT NULL,
	"provider_type" text NOT NULL,
	"external_instance" text,
	"external_type" text NOT NULL,
	"external_id" text NOT NULL,
	"external_url" text,
	"external_version" text,
	"snapshot" jsonb NOT NULL,
	"status" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integrations"."connection_capabilities" ADD CONSTRAINT "connection_capabilities_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "integrations"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."connection_checks" ADD CONSTRAINT "connection_checks_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "integrations"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."external_refs" ADD CONSTRAINT "external_refs_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "integrations"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connection_checks_conn_ix" ON "integrations"."connection_checks" USING btree ("connection_id","created_at");--> statement-breakpoint
CREATE INDEX "connections_org_type_ix" ON "integrations"."connections" USING btree ("org_id","provider_type");--> statement-breakpoint
CREATE UNIQUE INDEX "connections_org_name_ux" ON "integrations"."connections" USING btree ("org_id","display_name");--> statement-breakpoint
CREATE UNIQUE INDEX "external_refs_conn_type_id_ux" ON "integrations"."external_refs" USING btree ("connection_id","external_type","external_id");--> statement-breakpoint
CREATE INDEX "external_refs_project_type_ix" ON "integrations"."external_refs" USING btree ("project_id","external_type");