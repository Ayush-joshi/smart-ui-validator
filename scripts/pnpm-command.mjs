import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Windows cannot spawn the pnpm/npm .cmd/.ps1 shims without a shell, so prefer the JS entry points
// that pnpm exposes to lifecycle scripts and that ship beside the Node binary.
const execPath = process.env.npm_execpath ?? '';
const viaNode = /\.(?:c?js|mjs)$/u.test(execPath);

export function pnpm(arguments_, options = {}) {
  return viaNode
    ? execFileSync(process.execPath, [execPath, ...arguments_], options)
    : execFileSync('pnpm', arguments_, options);
}

const npmCli = [
  join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  join(dirname(process.execPath), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
].find((candidate) => existsSync(candidate));

export function npm(arguments_, options = {}) {
  return npmCli
    ? execFileSync(process.execPath, [npmCli, ...arguments_], options)
    : execFileSync('npm', arguments_, options);
}
