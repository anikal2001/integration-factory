// The sample repo's verify gate: every file under src/payments/providers must export a
// class that extends BaseProvider, declares a kebab-case `name`, and overrides every
// required method. Exit code 1 on the first violation — this is what blocks a PR.

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BaseProvider } from '../src/payments/BaseProvider.js';

const dir = path.resolve('src/payments/providers');
const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
let failures = 0;

for (const file of files) {
  const mod = await import(pathToFileURL(path.join(dir, file)).href);
  const classes = Object.values(mod).filter((v) => typeof v === 'function' && v.prototype instanceof BaseProvider);
  if (classes.length !== 1) {
    console.error(`✗ ${file}: expected exactly one exported class extending BaseProvider (found ${classes.length})`);
    failures += 1;
    continue;
  }
  const Provider = classes[0];
  const instance = new Provider();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(instance.name)) {
    console.error(`✗ ${file}: name "${instance.name}" is not kebab-case`);
    failures += 1;
  }
  if (!BaseProvider.implementsContract(Provider)) {
    console.error(`✗ ${file}: ${Provider.name} does not override every required method`);
    failures += 1;
  }
  if (failures === 0) console.log(`✓ ${file}: ${Provider.name} (${instance.name})`);
}

if (failures) {
  console.error(`${failures} provider check(s) failed`);
  process.exit(1);
}
console.log(`${files.length} provider(s) verified`);
