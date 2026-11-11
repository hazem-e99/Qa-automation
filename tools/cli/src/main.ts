import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitCodeFor, runDoctor } from './doctor.js';
import { initEnv } from './init.js';

const repoRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const [command] = process.argv.slice(2);

const USAGE = `Usage: pnpm qos <command>

  init     create infra/compose/.env with generated secrets (never overwrites)
  doctor   check that this machine can run the local stack`;

switch (command) {
  case 'init': {
    const result = await initEnv(repoRoot);
    console.log(
      result.created
        ? `Created ${path.relative(repoRoot, result.path)} with generated secrets.`
        : result.added.length
          ? `${path.relative(repoRoot, result.path)}: added ${result.added.join(', ')}; existing values unchanged.`
          : `${path.relative(repoRoot, result.path)} already exists; left unchanged.`,
    );
    if (result.masterKeyCreated) {
      console.log(
        'Created secrets/master.key. Back it up: without it, stored credentials cannot be decrypted.',
      );
    }
    break;
  }
  case 'doctor': {
    const results = await runDoctor({ repoRoot });
    const mark = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL' } as const;
    for (const r of results) console.log(`${mark[r.level]}  ${r.name.padEnd(16)} ${r.detail}`);
    process.exitCode = exitCodeFor(results);
    break;
  }
  default:
    console.log(USAGE);
    process.exitCode = command ? 2 : 0;
}
