import type { ProposedChange } from './providers.js';
import type { RepairProvider } from './repair-provider.js';

/**
 * Bridges an approved host-agent patch into the bounded repair coordinator.
 * The batch is emitted once; a later pass must be diagnosed and approved again.
 */
export class HostProposedRepairProvider implements RepairProvider {
  readonly name = 'host-proposed-repair-provider';
  private proposed = false;

  constructor(private readonly changes: readonly ProposedChange[]) {}

  async proposeRepair(): Promise<ProposedChange[]> {
    if (this.proposed) return [];
    this.proposed = true;
    return this.changes.map((change) => ({ ...change }));
  }
}
