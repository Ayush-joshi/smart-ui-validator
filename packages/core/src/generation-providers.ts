import type {
  DesignBundle,
  GeneratedHtmlBundle,
  GenerationRecord,
  SvgGenerationInput,
} from './generation-contracts.js';
import type { ArtifactRef } from './schemas.js';

export interface SvgInspectionResult {
  bundle: DesignBundle;
  sanitizedXml: string;
  sanitizedXmlWithoutText: string;
}

export interface SvgStructureProvider {
  readonly name: string;
  readonly version: string;
  inspect(input: SvgGenerationInput, signal?: AbortSignal): Promise<SvgInspectionResult>;
}

export interface HtmlGenerationProvider {
  readonly name: string;
  readonly version: string;
  generate(
    input: SvgGenerationInput,
    inspection: SvgInspectionResult,
    signal?: AbortSignal,
  ): Promise<GeneratedHtmlBundle>;
}

export interface GeneratedPreviewSession {
  url: string;
  origin: string;
  close(): Promise<void>;
}

export interface GeneratedPreviewProvider {
  serve(bundle: GeneratedHtmlBundle, signal?: AbortSignal): Promise<GeneratedPreviewSession>;
}

export interface GenerationReporter {
  write(record: GenerationRecord): Promise<ArtifactRef>;
}

export interface GenerationExporter {
  archive(files: readonly { relativePath: string; bytes: Uint8Array }[]): Promise<Uint8Array>;
  materialize(
    exportRoot: string,
    files: readonly { relativePath: string; bytes: Uint8Array }[],
  ): Promise<string[]>;
}
