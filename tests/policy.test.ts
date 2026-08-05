import { describe, expect, it } from 'vitest';
import { LocalPolicy, SmartUiError } from '../packages/core/src/index.js';

describe('LocalPolicy', () => {
  const policy = new LocalPolicy({
    targetRoot: '/tmp/smart-ui-target',
    writableFiles: ['src/Card.tsx'],
    allowedCommands: [
      { executable: 'pnpm', args: ['test'] },
      { executable: 'pnpm', args: ['typecheck'] },
    ],
    allowedEndpoints: ['http://127.0.0.1:4173'],
  });

  it('rejects traversal outside the target', () => {
    expect(() => policy.assertReadable('../secret')).toThrow(SmartUiError);
  });

  it('only permits explicitly writable files', () => {
    expect(() => policy.assertWritable('src/Card.tsx')).not.toThrow();
    expect(() => policy.assertWritable('src/Other.tsx')).toThrow(/not allowlisted/);
  });

  it('enforces exact command and argument allowlisting', () => {
    expect(() => policy.assertCommand('pnpm', ['test'])).not.toThrow();
    expect(() => policy.assertCommand('pnpm', ['test', '--watch'])).toThrow(/allowlisted/);
    expect(() => policy.assertCommand('sh', ['-c', 'anything'])).toThrow(/allowlisted/);
  });

  it('enforces endpoint allowlisting', () => {
    expect(() => policy.assertEndpoint('http://127.0.0.1:4173/page')).not.toThrow();
    expect(() => policy.assertEndpoint('https://example.com')).toThrow(/not allowlisted/);
  });
});
