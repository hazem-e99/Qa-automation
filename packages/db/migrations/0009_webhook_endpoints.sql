CREATE TABLE "integrations"."webhook_endpoints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"path_secret_hash" text NOT NULL,
	"verification" text NOT NULL,
	"secret_ref" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_delivery_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "integrations"."webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "integrations"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_endpoints_connection_ux" ON "integrations"."webhook_endpoints" USING btree ("connection_id");