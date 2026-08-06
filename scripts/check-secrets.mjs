import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);
const patterns = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['github-token', /\bgh[oprsu]_[A-Za-z0-9_]{30,}\b/],
  ['openai-key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['aws-access-key', /\bAKIA[A-Z0-9]{16}\b/],
];
const findings = [];
for (const file of files) {
  let content;
  try {
    content = await readFile(file, 'utf8');
  } catch {
    continue;
  }
  for (const [name, pattern] of patterns)
    if (pattern.test(content)) findings.push({ file, pattern: name });
}
if (findings.length > 0) {
  console.error(JSON.stringify({ findings }, null, 2));
  process.exitCode = 1;
} else {
  console.log(`Secret scan passed for ${files.length} tracked and untracked source files.`);
}
