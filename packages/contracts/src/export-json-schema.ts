import { mkdirSync, writeFileSync } from 'node:fs';
import { exportJsonSchemas } from './json-schema.js';

mkdirSync('dist/schemas', { recursive: true });
for (const [name, schema] of Object.entries(exportJsonSchemas())) {
  writeFileSync(`dist/schemas/${name}.schema.json`, JSON.stringify(schema, null, 2) + '\n');
}
console.log('wrote dist/schemas');
