import { describe, expect, it } from 'vitest';
import { isUrlAllowed, redactSensitiveText, sanitizeUrl } from '../packages/core/src/index.js';

describe('evidence redaction', () => {
  it('redacts credentials and query values', () => {
    expect(redactSensitiveText('Authorization: Bearer abc.def')).not.toContain('abc.def');
    expect(sanitizeUrl('https://user:pass@example.com/path?token=secret#fragment')).toBe(
      'https://example.com/path?token=%5BREDACTED%5D',
    );
  });

  it('matches endpoint path boundaries instead of string prefixes', () => {
    expect(isUrlAllowed('https://example.com/api/users', ['https://example.com/api'])).toBe(true);
    expect(isUrlAllowed('https://example.com/apievil', ['https://example.com/api'])).toBe(false);
  });
});
