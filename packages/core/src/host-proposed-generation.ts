import { createHash } from 'node:crypto';
import type {
  GeneratedHtmlBundle,
  GeneratedHtmlFile,
  SvgGenerationInput,
} from './generation-contracts.js';
import type { HtmlGenerationProvider, SvgInspectionResult } from './generation-providers.js';
import { SmartUiError } from './errors.js';

export interface HostProposedGenerationFile {
  relativePath: string;
  mediaType: 'text/html' | 'text/css' | 'image/svg+xml';
  content: string;
  rationale: string;
  sourceNodeIds?: string[];
}

/** Converts one user-approved host proposal into the provider-neutral generation contract. */
export class HostProposedHtmlGenerationProvider implements HtmlGenerationProvider {
  readonly name = 'host-proposed-html';
  readonly version = '1.0.0';
  readonly hostProposal: { host: string; proposalHash: string };
  private readonly files: GeneratedHtmlFile[];

  constructor(host: string, files: readonly HostProposedGenerationFile[]) {
    if (!host.trim()) throw new SmartUiError('INVALID_INPUT', 'Host proposal requires provenance.');
    this.files = files.map((file) => ({
      relativePath: file.relativePath,
      mediaType: file.mediaType,
      bytes: new TextEncoder().encode(file.content),
      rationale: file.rationale,
      sourceNodeIds: [...(file.sourceNodeIds ?? [])],
    }));
    this.hostProposal = { host: host.slice(0, 200), proposalHash: proposalHash(this.files) };
  }

  async generate(
    input: SvgGenerationInput,
    inspection: SvgInspectionResult,
    signal?: AbortSignal,
  ): Promise<GeneratedHtmlBundle> {
    if (signal?.aborted) throw new SmartUiError('PROVIDER_FAILURE', 'Host proposal was canceled.');
    return {
      files: this.files.map((file) => ({ ...file, bytes: file.bytes.slice() })),
      finalMode: input.mode,
      decisions: [
        ...inspection.bundle.layoutCandidates,
        ...inspection.bundle.semanticCandidates,
        {
          kind: 'host-proposed-semantic-generation',
          message:
            'Used a complete user-approved host file proposal only after core policy validation and deterministic comparison.',
          sourceNodeIds: [...new Set(this.files.flatMap((file) => file.sourceNodeIds))],
          confidence: 1,
          provenance: `${this.hostProposal.host}:${this.hostProposal.proposalHash}`,
        },
      ],
      uncertainties: [...inspection.bundle.uncertainties],
    };
  }
}

export function generatedManifestHash(
  files: readonly { relativePath: string; hash: string; mediaType?: string }[],
): string {
  const body = files
    .map((file) => `${file.relativePath}\0${file.mediaType ?? ''}\0${file.hash}`)
    .sort()
    .join('\n');
  return `sha256:${createHash('sha256').update(body).digest('hex')}`;
}

function proposalHash(files: readonly GeneratedHtmlFile[]): string {
  const digest = createHash('sha256');
  for (const file of [...files].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  )) {
    digest.update(file.relativePath);
    digest.update('\0');
    digest.update(file.mediaType);
    digest.update('\0');
    digest.update(file.bytes);
    digest.update('\0');
  }
  return `sha256:${digest.digest('hex')}`;
}
