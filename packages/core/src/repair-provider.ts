import type { DesignContract, ValidationFinding, RunRecord } from './schemas.js';
import type { RepositoryInspection, ProposedChange } from './providers.js';

export interface RepairProposalInput {
  contract: DesignContract;
  inspection: RepositoryInspection;
  findings: ValidationFinding[];
  runRecord: RunRecord;
  passIndex: number;
}

export interface RepairProvider {
  readonly name: string;
  proposeRepair(input: RepairProposalInput): Promise<ProposedChange[]>;
}
