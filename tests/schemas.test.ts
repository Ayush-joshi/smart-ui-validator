import { describe, expect, it } from 'vitest';
import { designContractSchema, runRecordSchema } from '../packages/core/src/index.js';

describe('versioned schemas', () => {
  it('rejects unknown design schema versions', () => {
    expect(() => designContractSchema.parse({ schemaVersion: '2.0' })).toThrow();
  });

  it('rejects incomplete run records', () => {
    expect(() => runRecordSchema.parse({ schemaVersion: '1.0', status: 'succeeded' })).toThrow();
  });
});
