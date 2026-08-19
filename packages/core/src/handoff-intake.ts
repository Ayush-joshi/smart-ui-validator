import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';
import type { Config } from './config.js';
import { SmartUiError } from './errors.js';
import {
  generationDesignContextSchema,
  presentationSpecSchema,
  structuredDesignContextSchema,
  type PresentationSpec,
  type StructuredDesignContext,
} from './generation-contracts.js';
import { readImageDimensions } from './image-dimensions.js';
import { redactSensitiveValue } from './security.js';

/**
 * Shared bounded intake for design references and optional context files. CLI, Studio, and MCP all
 * use this so a single boundary decides what counts as verified evidence, what is redacted, and what
 * provenance is recorded.
 */

export const MAX_DESIGN_CONTEXT_INTAKE_BYTES = 256_000;
type GenerationLimits = Config['generation']['limits'];

export interface PreparedDesignInput {
  /** Absolute path of the file the structure provider reads; a PNG is normalized to SVG first. */
  svgPath: string;
  /** Absolute path of the original user-supplied reference. */
  originalPath: string;
  filename: string;
  name: string;
  mediaType: 'image/svg+xml' | 'image/png';
  byteLength: number;
  originalHash: string;
  bytes: Uint8Array;
  normalizedSvg?: string;
  structureLimits: GenerationLimits;
}

/** Verifies and prepares one contained SVG or PNG design reference without writing to disk. */
export async function prepareDesignInput(
  root: string,
  designPath: string,
  limits: GenerationLimits,
): Promise<PreparedDesignInput> {
  const path = await containedRegularFile(root, designPath, 'Design reference');
  const extension = extname(path).toLowerCase();
  if (extension !== '.svg' && extension !== '.png') {
    throw new SmartUiError('INVALID_INPUT', 'A design reference must be an SVG or PNG file.');
  }
  const bytes = await readFile(path);
  if (bytes.byteLength < 1 || bytes.byteLength > limits.maxSvgBytes) {
    throw new SmartUiError(
      'INVALID_INPUT',
      `Design reference must be from 1 to ${limits.maxSvgBytes} bytes.`,
    );
  }
  const originalHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const base = {
    originalPath: path,
    filename: basename(path),
    name: basename(path, extension),
    byteLength: bytes.byteLength,
    originalHash,
    bytes,
  };
  if (extension === '.svg') {
    return { ...base, svgPath: path, mediaType: 'image/svg+xml', structureLimits: limits };
  }
  const dimensions = readImageDimensions(bytes, 'image/png');
  if (!dimensions) throw new SmartUiError('INVALID_INPUT', 'PNG dimensions are unavailable.');
  const normalizedSvg = pngReferenceSvg(bytes, dimensions.width, dimensions.height);
  if (Buffer.byteLength(normalizedSvg) > 50_000_000) {
    throw new SmartUiError('INVALID_INPUT', 'PNG reference is too large to normalize safely.');
  }
  return {
    ...base,
    svgPath: path,
    mediaType: 'image/png',
    normalizedSvg,
    structureLimits: expandedLimits(limits, Buffer.byteLength(normalizedSvg)),
  };
}

/** Deterministic SVG wrapper that lets the shared pipeline treat a PNG as bounded raster evidence. */
export function pngReferenceSvg(bytes: Uint8Array, width: number, height: number): string {
  const data = Buffer.from(bytes).toString('base64');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image width="${width}" height="${height}" preserveAspectRatio="none" href="data:image/png;base64,${data}"/></svg>`;
}

export function expandedLimits(
  limits: GenerationLimits,
  normalizedBytes: number,
): GenerationLimits {
  return {
    ...limits,
    maxSvgBytes: Math.max(limits.maxSvgBytes, normalizedBytes),
    maxDecodedCharacters: Math.max(limits.maxDecodedCharacters, normalizedBytes),
  };
}

export interface PreparedDesignContext {
  filename: string;
  mediaType: string;
  content: string;
  originalHash: string;
  byteLength: number;
  provenance: string;
  contentRedacted: boolean;
}

/**
 * Reads one optional UTF-8 source-context file. A file that is itself a valid structured context is
 * returned as typed context; anything else is retained as redacted untrusted text.
 */
export async function prepareDesignContextFile(
  root: string,
  contextPath: string,
  provenance: string,
): Promise<
  { structuredDesignContext: StructuredDesignContext } | { designContext: PreparedDesignContext }
> {
  const path = await containedRegularFile(root, contextPath, 'Design context');
  const bytes = await readFile(path);
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_DESIGN_CONTEXT_INTAKE_BYTES) {
    throw new SmartUiError(
      'INVALID_INPUT',
      `Design context must be a non-empty UTF-8 file no larger than ${MAX_DESIGN_CONTEXT_INTAKE_BYTES} bytes.`,
    );
  }
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SmartUiError('INVALID_INPUT', 'Design context must be strict UTF-8 text.');
  }
  if (content.includes('\0')) {
    throw new SmartUiError('INVALID_INPUT', 'Design context must be text, not binary data.');
  }
  try {
    const typed = structuredDesignContextSchema.safeParse(JSON.parse(content));
    if (typed.success) return { structuredDesignContext: typed.data };
  } catch {
    // Non-JSON source context is the common case.
  }
  const redacted = redactSensitiveValue(content);
  if (typeof redacted !== 'string') {
    throw new SmartUiError('INVALID_INPUT', 'Design context could not be normalized as text.');
  }
  return {
    designContext: generationDesignContextSchema.parse({
      filename: basename(path),
      mediaType: sourceContextMediaType(path),
      content: redacted,
      originalHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      byteLength: bytes.byteLength,
      provenance,
      contentRedacted: redacted !== content,
    }),
  };
}

export async function readStructuredContextFile(
  root: string,
  path: string,
): Promise<StructuredDesignContext> {
  const file = await containedRegularFile(root, path, 'Structured design context');
  return structuredDesignContextSchema.parse(JSON.parse(await readFile(file, 'utf8')));
}

export async function readPresentationSpecFile(
  root: string,
  path: string,
): Promise<PresentationSpec> {
  const file = await containedRegularFile(root, path, 'Presentation spec');
  return presentationSpecSchema.parse(JSON.parse(await readFile(file, 'utf8')));
}

/** Resolves a real regular file and proves it stays inside the declared containment root. */
export async function containedRegularFile(
  root: string,
  path: string,
  label: string,
): Promise<string> {
  const candidate = resolve(path);
  let info;
  try {
    info = await lstat(candidate);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new SmartUiError('NOT_FOUND', `${label} does not exist: ${candidate}`);
    }
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new SmartUiError('INVALID_INPUT', `${label} must be a regular file.`);
  }
  const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
  const relation = relative(realRoot, realCandidate);
  if (relation.startsWith('..') || isAbsolute(relation)) {
    throw new SmartUiError('POLICY_VIOLATION', `${label} crosses outside the declared root.`);
  }
  // Preserve the caller's lexical spelling after real paths proved containment; downstream policy
  // compares the declared root and candidate using that same spelling.
  return candidate;
}

export function sourceContextMediaType(path: string): string {
  return (
    {
      '.js': 'text/javascript',
      '.jsx': 'text/javascript',
      '.ts': 'text/typescript',
      '.tsx': 'text/typescript',
      '.html': 'text/html',
      '.css': 'text/css',
      '.json': 'application/json',
      '.md': 'text/markdown',
      '.txt': 'text/plain',
    }[extname(path).toLowerCase()] ?? 'text/plain'
  );
}
