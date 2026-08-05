import type { CodingProvider, ProposedChange } from './providers.js';

/** Explicit test double used to exercise policy and dry-run boundaries in Phase 1. */
export class MockCodingProvider implements CodingProvider {
  readonly name = 'mock-coding-provider';
  constructor(private readonly changes: ProposedChange[] = []) {}
  async propose(): Promise<ProposedChange[]> {
    return this.changes;
  }
}
