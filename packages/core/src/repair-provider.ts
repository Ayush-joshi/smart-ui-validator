import type { ArtifactRef, DesignContract, ValidationFinding } from './schemas.js';
import type { ProposedChange, RepositoryInspection } from './providers.js';

/** Compact, bounded diagnostic input. Large artifacts remain hash references. */
export interface RepairProposalInput {
  design: Pick<DesignContract, 'id' | 'name' | 'viewport' | 'component'>;
  inspection: RepositoryInspection;
  findings: ValidationFinding[];
  artifacts: ArtifactRef[];
  runId: string;
  previousScores: number[];
  passIndex: number;
}

export interface RepairProvider {
  readonly name: string;
  proposeRepair(input: RepairProposalInput): Promise<ProposedChange[]>;
}
