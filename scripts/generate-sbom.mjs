import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pnpm } from './pnpm-command.mjs';

const dependencyTree = JSON.parse(
  pnpm(['list', '--recursive', '--depth', 'Infinity', '--json'], {
    encoding: 'utf8',
    maxBuffer: 20_000_000,
  }),
);

const components = new Map();

async function visitDependencies(dependencies = {}) {
  for (const [name, dependency] of Object.entries(dependencies)) {
    if (!dependency?.version) continue;
    const key = `${name}@${dependency.version}`;
    if (!components.has(key)) {
      let license;
      try {
        const manifest = JSON.parse(await readFile(`${dependency.path}/package.json`, 'utf8'));
        const declared = manifest.license ?? manifest.licenses?.[0]?.type;
        if (typeof declared === 'string' && declared.length > 0) license = declared;
      } catch {
        // The dependency remains in the inventory with an explicit unknown license.
      }
      components.set(key, {
        type: 'library',
        name,
        version: dependency.version,
        'bom-ref': `pkg:npm/${encodeURIComponent(name)}@${dependency.version}`,
        purl: `pkg:npm/${encodeURIComponent(name)}@${dependency.version}`,
        licenses: [{ license: { id: license ?? 'NOASSERTION' } }],
      });
    }
    await visitDependencies(dependency.dependencies);
    await visitDependencies(dependency.devDependencies);
    await visitDependencies(dependency.optionalDependencies);
  }
}

for (const workspace of dependencyTree) {
  await visitDependencies(workspace.dependencies);
  await visitDependencies(workspace.devDependencies);
  await visitDependencies(workspace.optionalDependencies);
}

const componentList = [...components.values()].sort((left, right) =>
  left['bom-ref'].localeCompare(right['bom-ref']),
);
const document = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: { components: [{ type: 'application', name: 'smart-ui-local-sbom-generator' }] },
    component: { type: 'application', name: 'smart-ui-validator', version: '0.5.2' },
  },
  components: componentList,
};
const serialized = `${JSON.stringify(document, null, 2)}\n`;
await writeFile('sbom.local.json', serialized);
const digest = createHash('sha256').update(serialized).digest('hex');
console.log(`Wrote CycloneDX 1.5 SBOM with ${componentList.length} components (sha256:${digest}).`);
