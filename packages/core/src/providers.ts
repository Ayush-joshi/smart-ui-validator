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

export interface BrowserElementEvidence {
  validationId: string | undefined;
  tagName: string;
  selector: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  backgroundColor: string;
  borderColor: string;
  borderWidth: number;
  borderRadius: number;
  opacity: number;
  boxShadow: string;
  padding: { top: number; right: number; bottom: number; left: number };
  margin: { top: number; right: number; bottom: number; left: number };
  gap: number | undefined;
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
  lineHeight: string;
  letterSpacing: string;
  text: string;
  textWrap: boolean;
  role: string;
  accessibleName: string;
  accessibleState: Record<string, string | boolean>;
  keyboardReachable: boolean;
  focusVisible: boolean;
}

export interface BrowserEvidence {
  screenshot: Uint8Array;
  elements: BrowserElementEvidence[];
  consoleErrors: string[];
  failedRequests: string[];
}

export interface BrowserCaptureOptions {
  url: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  timeoutMs: number;
}

export interface BrowserProvider {
  readonly name: string;
  capture(options: BrowserCaptureOptions): Promise<BrowserEvidence>;
}

export interface ArtifactStore {
  put(bytes: Uint8Array, mediaType: string, label: string): Promise<ArtifactRef>;
  read(relativePath: string): Promise<Uint8Array>;
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
