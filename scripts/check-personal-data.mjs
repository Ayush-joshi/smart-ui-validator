#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const files = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: root },
)
  .toString('utf8')
  .split('\0')
  .filter(Boolean);
const configured = (process.env['SMART_UI_FORBIDDEN_IDENTIFIERS'] ?? '')
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const localUser = basename(homedir()).toLowerCase();
const localIdentity = normalizeIdentity(localUser);
const ignoredLocalUsers = new Set(['runner', 'root', 'container', 'sandbox']);
const violations = [];

for (const file of files) {
  const path = resolve(root, file);
  if ((await stat(path)).size > 5_000_000) continue;
  const bytes = await readFile(path);
  if (bytes.includes(0)) continue;
  const text = bytes.toString('utf8');
  const lower = text.toLowerCase();
  const normalized = normalizeIdentity(text);
  const reasons = [];
  if (/\b[A-Z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(text)) {
    reasons.push('email');
  }
  if (/(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[^/\\\s]+/iu.test(text)) {
    reasons.push('absolute-user-path');
  }
  if (
    localIdentity.length >= 6 &&
    !ignoredLocalUsers.has(localUser) &&
    normalized.includes(localIdentity)
  ) {
    reasons.push('local-user-identity');
  }
  if (configured.some((identifier) => lower.includes(identifier))) {
    reasons.push('configured-identifier');
  }
  if (reasons.length > 0) violations.push(`${file}: ${[...new Set(reasons)].join(', ')}`);
}

if (violations.length > 0) {
  console.error('Personal-data check failed:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`Personal-data check passed for ${files.length} source files.`);

function normalizeIdentity(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, '');
}
