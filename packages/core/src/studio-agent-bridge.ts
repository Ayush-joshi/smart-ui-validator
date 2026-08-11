import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { SvgGenerationInput } from './generation-contracts.js';
import type { SvgInspectionResult } from './generation-providers.js';
import type { HostProposedGenerationFile } from './host-proposed-generation.js';
import type { Config } from './config.js';
import { validateGeneratedBundle } from './generated-output.js';
import { SmartUiError } from './errors.js';

/**
 * File-based request/response queue that lets the MCP-connected chat agent author HTML for a Studio
 * run. Studio writes a bounded authoring request; the connected agent reads it through MCP and
 * writes a bounded response. Each run may hold several bounded rounds so the user can confirm the
 * result or ask for one more revision. All content is untrusted; every entry is validated on read
 * and write and fails closed. Large evidence is capped, not trusted.
 */

export const AUTHORING_QUEUE_DIRNAME = 'agent-queue';
const REQUESTS_DIRNAME = 'requests';
const RESPONSES_DIRNAME = 'responses';
const ROUND_FILE = /^round-([1-9][0-9]?)\.json$/u;
/**
 * Durable per-run high-water mark of issued rounds. Consumed round files are deleted once a round
 * is answered or abandoned, so this marker is what keeps round numbering strictly increasing.
 */
const ISSUED_FILE = 'issued.json';

export const AUTHORING_RUN_ID = /^run-[0-9a-f-]{36}$/u;
const MAX_SANITIZED_SVG_CHARACTERS = 200_000;
const MAX_READABLE_TEXT_NODES = 200;
const MAX_READABLE_TEXT_CHARACTERS = 400;
const MAX_INSTRUCTION_CHARACTERS = 4_000;
const MAX_FEEDBACK_CHARACTERS = 4_000;
const MAX_PRIOR_FINDINGS = 20;
const MAX_EVIDENCE_MESSAGE_CHARACTERS = 400;
const MAX_RESPONSE_FILES = 100;
const MAX_RESPONSE_FILE_CHARACTERS = 2_000_000;
const MAX_VISUAL_EVIDENCE_ITEMS = 4;
/** Workspace-relative POSIX artifact path with no traversal, drive letter, or absolute prefix. */
const WORKSPACE_RELATIVE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;

/** Hard upper bound on authoring rounds per run; Studio applies its own lower bound. */
export const MAX_AUTHORING_ROUNDS = 20;

/** Default time a Studio authoring request stays valid before it fails closed. */
export const DEFAULT_AUTHORING_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

const responseFilePath = z
  .string()
  .min(1)
  .max(1_024)
  .refine(
    (value) =>
      value === 'index.html' || value === 'styles.css' || /^assets\/[^/]+\.svg$/u.test(value),
    'Authored files must be index.html, styles.css, or assets/<name>.svg.',
  );

/**
 * Deterministic evidence from the previous round, derived by Studio from the immutable generation
 * record so a revision can target measured deltas instead of guessing.
 */
export const authoringPriorEvidenceSchema = z
  .object({
    round: z.number().int().min(1).max(MAX_AUTHORING_ROUNDS),
    visualSimilarityPercent: z.number().min(0).max(100).nullable(),
    visualMismatchPercent: z.number().min(0).max(100).nullable(),
    finalMode: z.enum(['exact', 'hybrid', 'semantic']).optional(),
    findings: z
      .array(
        z
          .object({
            category: z.string().min(1).max(100),
            severity: z.string().min(1).max(50),
            message: z.string().min(1).max(MAX_EVIDENCE_MESSAGE_CHARACTERS),
          })
          .strict(),
      )
      .max(MAX_PRIOR_FINDINGS),
    warnings: z.array(z.string().min(1).max(MAX_EVIDENCE_MESSAGE_CHARACTERS)).max(10),
  })
  .strict();

export type AuthoringPriorEvidence = z.infer<typeof authoringPriorEvidenceSchema>;

/**
 * Reference to one rendered PNG the authoring agent may look at. The path is relative to the Studio
 * workspace so the reader can re-validate containment instead of trusting an absolute path.
 */
export const authoringVisualEvidenceSchema = z
  .object({
    kind: z.enum(['design-render', 'previous-render', 'previous-diff', 'previous-overlay']),
    label: z.string().min(1).max(200),
    mediaType: z.literal('image/png'),
    workspaceRelativePath: z
      .string()
      .min(1)
      .max(1_024)
      .regex(WORKSPACE_RELATIVE_PATH, 'Evidence paths must be relative POSIX paths.')
      .refine((value) => !value.split('/').includes('..'), 'Evidence paths cannot traverse.'),
    hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    byteLength: z.number().int().positive().max(50_000_000),
    round: z.number().int().min(1).max(MAX_AUTHORING_ROUNDS).optional(),
  })
  .strict();

export type AuthoringVisualEvidence = z.infer<typeof authoringVisualEvidenceSchema>;

export const authoringRequestSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    runId: z.string().regex(AUTHORING_RUN_ID),
    round: z.number().int().min(1).max(MAX_AUTHORING_ROUNDS),
    designName: z.string().min(1).max(200),
    viewport: z
      .object({
        width: z.number().int().positive().max(10_000),
        height: z.number().int().positive().max(10_000),
      })
      .strict(),
    mode: z.enum(['exact', 'hybrid', 'semantic']),
    layout: z.enum(['fixed', 'responsive', 'component']),
    theme: z.enum(['light', 'dark']),
    locale: z.string().min(1).max(100),
    fallbackStack: z.string().min(1).max(2_000),
    unavailableFonts: z.array(z.string().min(1).max(200)).max(200),
    readableText: z
      .array(z.string().min(1).max(MAX_READABLE_TEXT_CHARACTERS))
      .max(MAX_READABLE_TEXT_NODES),
    instructions: z.string().max(MAX_INSTRUCTION_CHARACTERS).optional(),
    feedback: z.string().min(1).max(MAX_FEEDBACK_CHARACTERS).optional(),
    priorEvidence: authoringPriorEvidenceSchema.optional(),
    previousResponseHash: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/u)
      .optional(),
    sanitizedSvg: z.string().min(1).max(MAX_SANITIZED_SVG_CHARACTERS),
    svgTruncated: z.boolean(),
    visualEvidence: z
      .array(authoringVisualEvidenceSchema)
      .max(MAX_VISUAL_EVIDENCE_ITEMS)
      .optional(),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.round === 1 && (request.feedback || request.priorEvidence)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'The first authoring round cannot carry revision feedback or prior evidence.',
      });
    }
    if (request.round > 1 && !request.priorEvidence) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A revision round must carry deterministic prior evidence.',
      });
    }
  });

export type StudioAuthoringRequest = z.infer<typeof authoringRequestSchema>;

export const authoringResponseSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    runId: z.string().regex(AUTHORING_RUN_ID),
    round: z.number().int().min(1).max(MAX_AUTHORING_ROUNDS),
    authoringAgent: z.string().min(1).max(200),
    createdAt: z.string().datetime(),
    files: z
      .array(
        z
          .object({
            path: responseFilePath,
            content: z.string().min(1).max(MAX_RESPONSE_FILE_CHARACTERS),
          })
          .strict(),
      )
      .min(2)
      .max(MAX_RESPONSE_FILES)
      .superRefine((files, ctx) => {
        const paths = files.map((file) => file.path);
        if (new Set(paths).size !== paths.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Authored file paths must be unique.',
          });
        }
        if (!paths.includes('index.html') || !paths.includes('styles.css')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Authored files must include both index.html and styles.css.',
          });
        }
      }),
  })
  .strict();

export type StudioAuthoringResponse = z.infer<typeof authoringResponseSchema>;

const issuedMarkerSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    runId: z.string().regex(AUTHORING_RUN_ID),
    highestRound: z.number().int().min(1).max(MAX_AUTHORING_ROUNDS),
    updatedAt: z.string().datetime(),
  })
  .strict();

/** Absolute path of the authoring queue directory inside a Studio workspace. */
export function agentQueueRoot(studioWorkspace: string): string {
  return join(studioWorkspace, AUTHORING_QUEUE_DIRNAME);
}

/** Builds one bounded authoring request from an inspected design and user context. */
export function buildAuthoringRequest(options: {
  runId: string;
  input: SvgGenerationInput;
  inspection: SvgInspectionResult;
  round?: number;
  feedback?: string;
  priorEvidence?: AuthoringPriorEvidence;
  previousResponseHash?: string;
  visualEvidence?: readonly AuthoringVisualEvidence[];
  timeoutMs?: number;
  now?: Date;
}): StudioAuthoringRequest {
  const { input, inspection } = options;
  const bundle = inspection.bundle;
  const now = options.now ?? new Date();
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const round = options.round ?? 1;
  const feedback = options.feedback?.trim().slice(0, MAX_FEEDBACK_CHARACTERS);
  const readableText = bundle.scene.nodes
    .filter((node) => node.type === 'text' && Boolean(node.text?.trim()))
    .map((node) => node.text!.trim().slice(0, MAX_READABLE_TEXT_CHARACTERS))
    .slice(0, MAX_READABLE_TEXT_NODES);
  const svgTruncated = inspection.sanitizedXml.length > MAX_SANITIZED_SVG_CHARACTERS;
  return authoringRequestSchema.parse({
    schemaVersion: '1.0',
    runId: options.runId,
    round,
    designName: bundle.name.slice(0, 200) || 'design',
    viewport: { width: bundle.viewport.width, height: bundle.viewport.height },
    mode: input.mode,
    layout: input.layout,
    theme: input.rendering.theme,
    locale: input.rendering.locale,
    fallbackStack: bundle.fontPolicy.fallbackStack.slice(0, 2_000),
    unavailableFonts: bundle.fontPolicy.unavailableFonts
      .slice(0, 200)
      .map((font) => font.slice(0, 200)),
    readableText,
    ...(input.instructions
      ? { instructions: input.instructions.slice(0, MAX_INSTRUCTION_CHARACTERS) }
      : {}),
    ...(feedback ? { feedback } : {}),
    ...(options.priorEvidence ? { priorEvidence: options.priorEvidence } : {}),
    ...(options.previousResponseHash ? { previousResponseHash: options.previousResponseHash } : {}),
    sanitizedSvg: svgTruncated
      ? inspection.sanitizedXml.slice(0, MAX_SANITIZED_SVG_CHARACTERS)
      : inspection.sanitizedXml,
    svgTruncated,
    ...(options.visualEvidence && options.visualEvidence.length > 0
      ? { visualEvidence: options.visualEvidence.slice(0, MAX_VISUAL_EVIDENCE_ITEMS) }
      : {}),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + timeoutMs).toISOString(),
  });
}

/**
 * Per-request guidance that anchors the authored HTML to the exact canvas the deterministic
 * pipeline renders and compares against, so the result matches the design's size and scale.
 */
export function authoringCanvasGuidance(request: StudioAuthoringRequest): string {
  const { width, height } = request.viewport;
  const base =
    `The design is rendered and compared at exactly ${width}x${height} device-independent pixels. ` +
    `Match that canvas: preserve the design's size, aspect ratio, and scale, and do not assume a larger page.`;
  const layout =
    request.layout === 'responsive'
      ? ` Author a responsive layout anchored to a ${width}px-wide viewport (design from there); the root must fill ${width}x${height} with no clipping or scrollbars.`
      : request.layout === 'component'
        ? ` Author a self-contained component whose root box is exactly ${width}x${height} pixels.`
        : ` Author a fixed page whose root and body are exactly ${width}x${height} pixels with no overflow.`;
  return base + layout;
}

/**
 * Bounded revision guidance for round > 1 that repeats the user's feedback and the deterministic
 * deltas measured on the previous round. It states evidence; it never scores or promises an outcome.
 */
export function authoringRevisionGuidance(request: StudioAuthoringRequest): string | undefined {
  if (request.round === 1) return undefined;
  const prior = request.priorEvidence;
  const parts = [
    `This is authoring round ${request.round} for the same design; revise the previous output rather than restarting from nothing.`,
  ];
  if (prior) {
    const similarity =
      prior.visualSimilarityPercent === null
        ? 'not scored'
        : `${prior.visualSimilarityPercent.toFixed(3)}%`;
    const mismatch =
      prior.visualMismatchPercent === null
        ? 'not scored'
        : `${prior.visualMismatchPercent.toFixed(3)}%`;
    parts.push(
      `Round ${prior.round} measured ${similarity} visual similarity to the design (${mismatch} mismatch).`,
    );
    if (prior.findings.length > 0) {
      parts.push(
        `Deterministic findings to address: ${prior.findings
          .map((finding) => `${finding.category}/${finding.severity}: ${finding.message}`)
          .join(' | ')}`,
      );
    }
    if (prior.warnings.length > 0) parts.push(`Warnings: ${prior.warnings.join(' | ')}`);
  }
  if (request.feedback) parts.push(`The user asked for: ${request.feedback}`);
  return parts.join(' ');
}

/** Stable content hash of an authored response, used as revision provenance. */
export function authoringResponseHash(response: StudioAuthoringResponse): string {
  const canonical = JSON.stringify(
    [...response.files]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => [file.path, file.content]),
  );
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/**
 * Highest round ever issued for a run, including rounds whose request file was already consumed or
 * abandoned. Callers derive the next round from this so numbering never collides or dead-ends.
 */
export async function highestIssuedAuthoringRound(
  queueRoot: string,
  runId: string,
): Promise<number> {
  assertRunId(runId);
  return highestIssued(join(queueRoot, REQUESTS_DIRNAME, runId));
}

/**
 * Atomically writes a validated authoring request for one round. Rounds must be strictly
 * increasing; a stale or duplicate round is refused.
 */
export async function writeAuthoringRequest(
  queueRoot: string,
  request: StudioAuthoringRequest,
): Promise<string> {
  const validated = authoringRequestSchema.parse(request);
  const directory = join(queueRoot, REQUESTS_DIRNAME, validated.runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const latest = await highestIssued(directory);
  if (validated.round !== latest + 1) {
    throw new SmartUiError(
      'POLICY_VIOLATION',
      `Studio authoring round ${validated.round} is stale or duplicated; the next expected round is ${latest + 1}.`,
    );
  }
  const destination = join(directory, roundFileName(validated.round));
  await atomicWriteJson(destination, validated);
  await atomicWriteJson(join(directory, ISSUED_FILE), {
    schemaVersion: '1.0',
    runId: validated.runId,
    highestRound: validated.round,
    updatedAt: validated.createdAt,
  });
  return destination;
}

/** Reads and validates one authoring request; defaults to the latest round of the run. */
export async function readAuthoringRequest(
  queueRoot: string,
  runId: string,
  round?: number,
): Promise<StudioAuthoringRequest | undefined> {
  assertRunId(runId);
  const directory = join(queueRoot, REQUESTS_DIRNAME, runId);
  const target = round ?? (await listRounds(directory)).at(-1);
  if (target === undefined) return undefined;
  const raw = await readOptional(join(directory, roundFileName(assertRound(target))));
  if (raw === undefined) return undefined;
  return authoringRequestSchema.parse(parseJson(raw, 'authoring request'));
}

/**
 * Lists the latest valid, unexpired, unanswered request per run. Malformed, superseded, expired, or
 * already answered entries are skipped.
 */
export async function listPendingAuthoringRequests(
  queueRoot: string,
  now: Date = new Date(),
): Promise<StudioAuthoringRequest[]> {
  const root = join(queueRoot, REQUESTS_DIRNAME);
  const pending: StudioAuthoringRequest[] = [];
  for (const runId of (await listEntries(root)).sort()) {
    if (!AUTHORING_RUN_ID.test(runId)) continue;
    const directory = join(root, runId);
    const round = (await listRounds(directory)).at(-1);
    if (round === undefined) continue;
    const raw = await readOptional(join(directory, roundFileName(round)));
    if (raw === undefined) continue;
    const parsed = authoringRequestSchema.safeParse(safeParseJson(raw));
    if (!parsed.success) continue;
    if (Date.parse(parsed.data.expiresAt) <= now.getTime()) continue;
    if (await readOptional(responsePath(queueRoot, runId, round))) continue;
    pending.push(parsed.data);
  }
  return pending;
}

/** Atomically writes a validated authoring response for the run's pending round. */
export async function writeAuthoringResponse(
  queueRoot: string,
  response: StudioAuthoringResponse,
): Promise<string> {
  const validated = authoringResponseSchema.parse(response);
  const request = await readAuthoringRequest(queueRoot, validated.runId);
  if (!request) {
    throw new SmartUiError(
      'NOT_FOUND',
      'No pending Studio authoring request matches this run identifier.',
    );
  }
  if (request.round !== validated.round) {
    throw new SmartUiError(
      'POLICY_VIOLATION',
      `Studio is waiting for authoring round ${request.round}; round ${validated.round} is stale.`,
    );
  }
  const destination = responsePath(queueRoot, validated.runId, validated.round);
  if (await readOptional(destination)) {
    throw new SmartUiError(
      'POLICY_VIOLATION',
      `Authoring round ${validated.round} of this Studio run was already answered.`,
    );
  }
  await mkdir(join(queueRoot, RESPONSES_DIRNAME, validated.runId), {
    recursive: true,
    mode: 0o700,
  });
  await atomicWriteJson(destination, validated);
  return destination;
}

/** Reads and validates one authoring response; defaults to the latest requested round. */
export async function readAuthoringResponse(
  queueRoot: string,
  runId: string,
  round?: number,
): Promise<StudioAuthoringResponse | undefined> {
  assertRunId(runId);
  const target =
    round ?? (await listRounds(join(queueRoot, REQUESTS_DIRNAME, runId))).at(-1) ?? undefined;
  if (target === undefined) return undefined;
  const raw = await readOptional(responsePath(queueRoot, runId, assertRound(target)));
  if (raw === undefined) return undefined;
  return authoringResponseSchema.parse(parseJson(raw, 'authoring response'));
}

/**
 * Polls for a validated authoring response for one round, failing closed when the run is canceled,
 * the request expires, or the bounded timeout elapses.
 */
export async function waitForAuthoringResponse(
  queueRoot: string,
  runId: string,
  options: {
    round?: number;
    timeoutMs?: number;
    pollIntervalMs?: number;
    signal?: AbortSignal;
    now?: () => number;
  } = {},
): Promise<StudioAuthoringResponse> {
  assertRunId(runId);
  const clock = options.now ?? (() => Date.now());
  const started = clock();
  const round = options.round === undefined ? undefined : assertRound(options.round);
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const pollIntervalMs = Math.max(
    50,
    Math.min(30_000, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS),
  );
  for (;;) {
    if (options.signal?.aborted) {
      throw new SmartUiError('TIMEOUT', 'The Studio authoring request was canceled.');
    }
    const response = await readAuthoringResponse(queueRoot, runId, round);
    if (response) return response;
    const request = await readAuthoringRequest(queueRoot, runId, round);
    if (request && Date.parse(request.expiresAt) <= clock()) {
      throw new SmartUiError(
        'TIMEOUT',
        'The Studio authoring request expired before the agent responded.',
      );
    }
    if (clock() - started >= timeoutMs) {
      throw new SmartUiError(
        'TIMEOUT',
        'No connected MCP agent authored this design in time. Retry, or switch this run to the deterministic engine.',
      );
    }
    await delay(pollIntervalMs, options.signal);
  }
}

/** Removes one pending authoring round, or every round of the run when no round is given. */
export async function deleteAuthoringRequest(
  queueRoot: string,
  runId: string,
  round?: number,
): Promise<void> {
  assertRunId(runId);
  const directory = join(queueRoot, REQUESTS_DIRNAME, runId);
  if (round === undefined) {
    await rm(directory, { recursive: true, force: true });
    return;
  }
  await rm(join(directory, roundFileName(assertRound(round))), { force: true });
}

/** Removes one consumed authoring response, or every response of the run. */
export async function deleteAuthoringResponse(
  queueRoot: string,
  runId: string,
  round?: number,
): Promise<void> {
  assertRunId(runId);
  if (round === undefined) {
    await rm(join(queueRoot, RESPONSES_DIRNAME, runId), { recursive: true, force: true });
    return;
  }
  await rm(responsePath(queueRoot, runId, assertRound(round)), { force: true });
}

/** Converts a validated authoring response into provider-neutral host proposal files. */
export function authoredHostFiles(response: StudioAuthoringResponse): HostProposedGenerationFile[] {
  return response.files.map((file) => ({
    relativePath: file.path,
    mediaType: authoredMediaType(file.path),
    content: file.content,
    rationale: `Authored by ${response.authoringAgent} from the sanitized SVG design evidence.`,
  }));
}

/**
 * Applies the complete generated-output boundary before Studio consumes an authored response.
 * This keeps syntax and offline-policy failures in the MCP submission flow, where the author can
 * correct them, instead of creating an unscored failed Studio round.
 */
export function validateAuthoredResponse(
  response: StudioAuthoringResponse,
  limits: Config['generation']['limits'],
): void {
  const files = authoredHostFiles(response).map((file) => ({
    relativePath: file.relativePath,
    mediaType: file.mediaType,
    bytes: new TextEncoder().encode(file.content),
    rationale: file.rationale,
    sourceNodeIds: [...(file.sourceNodeIds ?? [])],
  }));
  validateGeneratedBundle(
    {
      files,
      finalMode: 'semantic',
      decisions: [],
      uncertainties: [],
    },
    limits,
  );
}

function authoredMediaType(path: string): HostProposedGenerationFile['mediaType'] {
  if (path === 'index.html') return 'text/html';
  if (path === 'styles.css') return 'text/css';
  return 'image/svg+xml';
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_AUTHORING_TIMEOUT_MS;
  if (!Number.isFinite(value) || value < 1_000 || value > 60 * 60 * 1_000) {
    throw new SmartUiError(
      'INVALID_INPUT',
      'Authoring timeout must be between 1000 and 3600000 milliseconds.',
    );
  }
  return Math.floor(value);
}

function assertRunId(runId: string): void {
  if (!AUTHORING_RUN_ID.test(runId)) {
    throw new SmartUiError('INVALID_INPUT', 'A Studio run identifier is required.');
  }
}

function assertRound(round: number): number {
  if (!Number.isInteger(round) || round < 1 || round > MAX_AUTHORING_ROUNDS) {
    throw new SmartUiError(
      'INVALID_INPUT',
      `A Studio authoring round must be an integer from 1 to ${MAX_AUTHORING_ROUNDS}.`,
    );
  }
  return round;
}

function roundFileName(round: number): string {
  return `round-${round}.json`;
}

function responsePath(queueRoot: string, runId: string, round: number): string {
  return join(queueRoot, RESPONSES_DIRNAME, runId, roundFileName(round));
}

async function listEntries(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}

/** Ascending round numbers present in one run directory. */
async function listRounds(directory: string): Promise<number[]> {
  return (await listEntries(directory))
    .map((name) => ROUND_FILE.exec(name)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number)
    .filter((round) => round >= 1 && round <= MAX_AUTHORING_ROUNDS)
    .sort((left, right) => left - right);
}

/**
 * Highest round issued for one run directory. Round files are removed once consumed, so the marker
 * is authoritative; a missing or malformed marker degrades to the rounds still on disk.
 */
async function highestIssued(directory: string): Promise<number> {
  const onDisk = (await listRounds(directory)).at(-1) ?? 0;
  const marker = issuedMarkerSchema.safeParse(
    safeParseJson((await readOptional(join(directory, ISSUED_FILE))) ?? ''),
  );
  return Math.max(onDisk, marker.success ? marker.data.highestRound : 0);
}

async function atomicWriteJson(destination: string, value: unknown): Promise<void> {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new SmartUiError('INVALID_INPUT', `The Studio ${label} is not valid JSON.`);
  }
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function missing(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ENOENT'
  );
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((accept) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      accept();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      accept();
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}
