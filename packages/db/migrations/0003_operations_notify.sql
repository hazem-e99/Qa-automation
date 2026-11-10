-- Hand-written migration: wake up SSE listeners when an operation changes.
CREATE FUNCTION "platform"."operations_notify"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	PERFORM pg_notify('qos_operations', NEW.id::text);
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "operations_notify"
	AFTER INSERT OR UPDATE ON "platform"."operations"
	FOR EACH ROW EXECUTE FUNCTION "platform"."operations_notify"();
