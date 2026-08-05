import { describe, expect, it } from 'vitest';
import { LocalPolicy, SmartUiError } from '../packages/core/src/index.js';

describe('LocalPolicy', () => {
  const policy = new LocalPolicy({
    targetRoot: '/tmp/smart-ui-target',
    writableFiles: ['src/Card.tsx'],
    allowedCommands: { pnpm: ['test', 'typecheck'] },
  });

  it('rejects traversal outside the target', () => {
    expect(() => policy.assertReadable('../secret')).toThrow(SmartUiError);
  });

  it('only permits explicitly writable files', () => {
    expect(() => policy.assertWritable('src/Card.tsx')).not.toThrow();
    expect(() => policy.assertWritable('src/Other.tsx')).toThrow(/not allowlisted/);
  });

  it('enforces command and argument prefixes', () => {
    expect(() => policy.assertCommand('pnpm', ['test'])).not.toThrow();
    expect(() => policy.assertCommand('sh', ['-c', 'anything'])).toThrow(/not allowlisted/);
  });
});
