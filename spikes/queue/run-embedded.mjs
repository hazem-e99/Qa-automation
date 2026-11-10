// Runs spike.mjs against an embedded Postgres (no Docker). Data dir on D:, removed afterwards.
import EmbeddedPostgres from 'embedded-postgres';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const dir = 'D:/dev/.tmp/pg-spike';
fs.rmSync(dir, { recursive: true, force: true });
const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'spike', password: 'spike', port: 55432, persistent: false });
await pg.initialise(); await pg.start(); await pg.createDatabase('spike');
const r = spawnSync(process.execPath, ['spike.mjs'], { stdio: 'inherit' });
await pg.stop(); fs.rmSync(dir, { recursive: true, force: true });
process.exit(r.status ?? 1);
