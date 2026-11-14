-- Hand-written migration: privileges for the new `traceability` schema (same rules as 0014/0017).
GRANT USAGE ON SCHEMA traceability TO qos_app, qos_readonly, qos_retention;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA traceability TO qos_app;
--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA traceability TO qos_readonly, qos_retention;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA traceability GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO qos_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA traceability GRANT SELECT ON TABLES TO qos_readonly, qos_retention;
