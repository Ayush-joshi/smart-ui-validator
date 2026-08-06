import type { ArtifactRef, DesignContract, RunRecord } from './schemas.js';

export interface DesignProvider<Input = unknown> {
  readonly name: string;
  normalize(input: Input): Promise<DesignContract>;
}

export interface RepositoryInspection {
  root: string;
  framework: 'react' | 'angular' | 'unknown';
  buildSystem: string | null;
  packageManager: string | null;
  styling: string[];
  testFrameworks: string[];
  componentLocations: string[];
  routing?: string[];
  stateManagement?: string[];
  storybook?: boolean;
  componentCandidates?: Array<{
    name: string;
    relativePath: string;
    kind: 'component' | 'directive' | 'service';
    selector?: string;
  }>;
  designTokens?: Array<{
    name: string;
    source: string;
    kind: 'css-custom-property' | 'typescript' | 'scss';
    value?: string;
  }>;
  conventions?: string[];
  ambiguities?: string[];
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
  alignItems: string;
  justifyContent: string;
  overflowX: string;
  overflowY: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
  lineHeight: string;
  letterSpacing: string;
  text: string;
  textWrap: boolean;
  lineCount: number;
  assetSource: string | undefined;
  intrinsicWidth: number | undefined;
  intrinsicHeight: number | undefined;
  objectFit: string;
  objectPosition: string;
  role: string;
  accessibleName: string;
  accessibleState: Record<string, string | boolean | number>;
  keyboardReachable: boolean;
  focusVisible: boolean;
  contrastRatio?: number;
}

export interface BrowserEvidence {
  screenshot: Uint8Array;
  elements: BrowserElementEvidence[];
  consoleErrors: string[];
  failedRequests: string[];
  accessibilityViolations?: Array<{
    rule: string;
    selector: string;
    message: string;
  }>;
  dynamicRegions?: Array<{ x: number; y: number; width: number; height: number }>;
  interactionState?: string;
}

export type BrowserInteractionState =
  | 'default'
  | 'hover'
  | 'focus'
  | 'active'
  | 'disabled'
  | 'loading'
  | 'empty'
  | 'error';

export interface BrowserCaptureOptions {
  url: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  timeoutMs: number;
  locale: string;
  theme: 'light' | 'dark';
  allowedEndpoints: string[];
  blockExternalNetwork: boolean;
  interaction?: {
    name: BrowserInteractionState;
    selector?: string;
  };
  dynamicRegionSelectors?: string[];
  evidenceLimits: {
    maxElements: number;
    maxTextLength: number;
    maxConsoleMessages: number;
    maxFailedRequests: number;
    maxArtifactBytes: number;
  };
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
  assertEndpoint(url: string): void;
  readonly writableFiles: readonly string[];
  readonly dryRun: boolean;
  readonly maxExecutionTimeMs: number;
}

export interface Reporter {
  write(record: RunRecord): Promise<ArtifactRef>;
}
