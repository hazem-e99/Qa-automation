import { defineConfig } from 'drizzle-kit';

// Only the declarative schemas are listed here. Partitioned tables live in hand-written
// migrations (see src/schema/governance.ts).
export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/schema/platform.ts'],
  out: './migrations',
});
