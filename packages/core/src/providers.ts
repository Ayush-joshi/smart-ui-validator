import type { ArtifactRef, DesignContract, RunRecord } from './schemas.js';

export interface DesignProvider<Input = unknown> {
  readonly name: string;
  normalize(input: Input): Promise<DesignContract>;
}

export interface RepositoryInspection {
  root: string;
  framework: 'react' | 'unknown';
  buildSystem: string | null;
  packageManager: string | null;
  styling: string[];
  testFrameworks: string[];
  componentLocations: string[];
}

export interface FrameworkAdapter {
  readonly framework: string;
  inspect(targetRoot: string): Promise<RepositoryInspection>;
}

export interface ProposedChange {
  relativePath: string;
  content: string;
  rationale: string;
}

export interface CodingProvider {
  readonly name: string;
  propose(contract: DesignContract, inspection: RepositoryInspection): Promise<ProposedChange[]>;
}

export interface BrowserCaptureOptions {
  url: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  timeoutMs: number;
}

export interface BrowserProvider {
  readonly name: string;
  capture(options: BrowserCaptureOptions): Promise<Uint8Array>;
}

export interface ArtifactStore {
  put(bytes: Uint8Array, mediaType: string, label: string): Promise<ArtifactRef>;
  readManifest(): Promise<ArtifactRef[]>;
}

export interface PolicyProvider {
  assertReadable(path: string): void;
  assertWritable(path: string): void;
  assertCommand(command: string, args: readonly string[]): void;
  readonly dryRun: boolean;
  readonly maxExecutionTimeMs: number;
}

export interface Reporter {
  write(record: RunRecord): Promise<ArtifactRef>;
}
