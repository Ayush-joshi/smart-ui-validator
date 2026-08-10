import { access, cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'apps/studio/dist');
const destination = join(root, 'apps/cli/dist/studio');

await access(join(source, 'server.js'));
await access(join(source, 'public/index.html'));
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(join(source, 'server.js'), join(destination, 'server.js'));
await cp(join(source, 'public'), join(destination, 'public'), { recursive: true });
console.log('Copied reviewed Studio production assets into apps/cli/dist/studio.');
