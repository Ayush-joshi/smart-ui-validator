import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { SvgGenerationInput } from './generation-contracts.js';
import type { SvgInspectionResult } from './generation-providers.js';
import type { HostProposedGenerationFile } from './host-proposed-generation.js';
import { SmartUiError } from './errors.js';

/**
 * File-based request/response queue that lets the MCP-connected chat agent author HTML for a Studio
 * run. Studio writes a bounded authoring request; the connected agent reads it through MCP and
 * writes a bounded response. All content is untrusted; every entry is validated on read and write
 * and fails closed. Large evidence is capped, not trusted.
 */

export const AUTHORING_QUEUE_DIRNAME = 'agent-queue';
const REQUESTS_DIRNAME = 'requests';
const RESPONSES_DIRNAME = 'responses';

export const AUTHORING_RUN_ID = /^run-[0-9a-f-]{36}$/u;
const MAX_SANITIZED_SVG_CHARACTERS = 200_000;
const MAX_READABLE_TEXT_NODES = 200;
const MAX_READABLE_TEXT_CHARACTERS = 400;
const MAX_INSTRUCTION_CHARACTERS = 4_000;
const MAX_RESPONSE_FILES = 100;
const MAX_RESPONSE_FILE_CHARACTERS = 2_000_000;

/** Default time a Studio authoring request stays valid before it fails closed. */
export const DEFAULT_AUTHORING_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

const responseFilePath = z
  .string()
  .min(1)
  .max(1_024)
  .refine(
    (value) => value === 'index.html' || value === 'styles.css' || /^assets\/[^/]+\.svg$/u.test(value),
    'Authored files must be index.html, styles.css, or assets/<name>.svg.',
  );

export const authoringRequestSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    runId: z.string().regex(AUTHORING_RUN_ID),
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
    readableText: z.array(z.string().min(1).max(MAX_READABLE_TEXT_CHARACTERS)).max(
      MAX_READABLE_TEXT_NODES,
    ),
    instructions: z.string().max(MAX_INSTRUCTION_CHARACTERS).optional(),
    sanitizedSvg: z.string().min(1).max(MAX_SANITIZED_SVG_CHARACTERS),
    svgTruncated: z.boolean(),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();

export type StudioAuthoringRequest = z.infer<typeof authoringRequestSchema>;

export const authoringResponseSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    runId: z.string().regex(AUTHORING_RUN_ID),
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
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Authored file paths must be unique.' });
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

/** Absolute path of the authoring queue directory inside a Studio workspace. */
export function agentQueueRoot(studioWorkspace: string): string {
  return join(studioWorkspace, AUTHORING_QUEUE_DIRNAME);
}

/** Builds one bounded authoring request from an inspected design and user context. */
export function buildAuthoringRequest(options: {
  runId: string;
  input: SvgGenerationInput;
  inspection: SvgInspectionResult;
  timeoutMs?: number;
  now?: Date;
}): StudioAuthoringRequest {
  const { input, inspection } = options;
  const bundle = inspection.bundle;
  const now = options.now ?? new Date();
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const readableText = bundle.scene.nodes
    .filter((node) => node.type === 'text' && Boolean(node.text?.trim()))
    .map((node) => node.text!.trim().slice(0, MAX_READABLE_TEXT_CHARACTERS))
    .slice(0, MAX_READABLE_TEXT_NODES);
  const svgTruncated = inspection.sanitizedXml.length > MAX_SANITIZED_SVG_CHARACTERS;
  return authoringRequestSchema.parse({
    schemaVersion: '1.0',
    runId: options.runId,
    designName: bundle.name.slice(0, 200) || 'design',
    viewport: { width: bundle.viewport.width, height: bundle.viewport.height },
    mode: input.mode,
    layout: input.layout,
    theme: input.rendering.theme,
    locale: input.rendering.locale,
    fallbackStack: bundle.fontPolicy.fallbackStack.slice(0, 2_000),
    unavailableFonts: bundle.fontPolicy.unavailableFonts.slice(0, 200).map((font) => font.slice(0, 200)),
    readableText,
    ...(input.instructions ? { instructions: input.instructions.slice(0, MAX_INSTRUCTION_CHARACTERS) } : {}),
    sanitizedSvg: svgTruncated
      ? inspection.sanitizedXml.slice(0, MAX_SANITIZED_SVG_CHARACTERS)
      : inspection.sanitizedXml,
    svgTruncated,
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

/** Atomically writes a validated authoring request; refuses to overwrite an existing one. */
export async function writeAuthoringRequest(
  queueRoot: string,
  request: StudioAuthoringRequest,
): Promise<string> {
  const validated = authoringRequestSchema.parse(request);
  const directory = join(queueRoot, REQUESTS_DIRNAME);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = join(directory, `${validated.runId}.json`);
  await atomicWriteJson(destination, validated);
  return destination;
}

/** Reads and validates one authoring request; returns undefined when absent. */
export async function readAuthoringRequest(
  queueRoot: string,
  runId: string,
): Promise<StudioAuthoringRequest | undefined> {
  assertRunId(runId);
  const raw = await readOptional(join(queueRoot, REQUESTS_DIRNAME, `${runId}.json`));
  if (raw === undefined) return undefined;
  return authoringRequestSchema.parse(parseJson(raw, 'authoring request'));
}

/** Lists valid, unexpired pending requests. Malformed or expired entries are skipped. */
export async function listPendingAuthoringRequests(
  queueRoot: string,
  now: Date = new Date(),
): Promise<StudioAuthoringRequest[]> {
  const directory = join(queueRoot, REQUESTS_DIRNAME);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  const pending: StudioAuthoringRequest[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const raw = await readOptional(join(directory, name));
    if (raw === undefined) continue;
    const parsed = authoringRequestSchema.safeParse(safeParseJson(raw));
    if (!parsed.success) continue;
    if (Date.parse(parsed.data.expiresAt) <= now.getTime()) continue;
    pending.push(parsed.data);
  }
  return pending;
}

/** Atomically writes a validated authoring response. */
export async function writeAuthoringResponse(
  queueRoot: string,
  response: StudioAuthoringResponse,
): Promise<string> {
  const validated = authoringResponseSchema.parse(response);
  const directory = join(queueRoot, RESPONSES_DIRNAME);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = join(directory, `${validated.runId}.json`);
  await atomicWriteJson(destination, validated);
  return destination;
}

/** Reads and validates one authoring response; returns undefined when absent. */
export async function readAuthoringResponse(
  queueRoot: string,
  runId: string,
): Promise<StudioAuthoringResponse | undefined> {
  assertRunId(runId);
  const raw = await readOptional(join(queueRoot, RESPONSES_DIRNAME, `${runId}.json`));
  if (raw === undefined) return undefined;
  return authoringResponseSchema.parse(parseJson(raw, 'authoring response'));
}

/**
 * Polls for a validated authoring response, failing closed when the run is canceled, the request
 * expires, or the bounded timeout elapses.
 */
export async function waitForAuthoringResponse(
  queueRoot: string,
  runId: string,
  options: { timeoutMs?: number; pollIntervalMs?: number; signal?: AbortSignal; now?: () => number } = {},
): Promise<StudioAuthoringResponse> {
  assertRunId(runId);
  const clock = options.now ?? (() => Date.now());
  const started = clock();
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const pollIntervalMs = Math.max(50, Math.min(30_000, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));
  for (;;) {
    if (options.signal?.aborted) {
      throw new SmartUiError('TIMEOUT', 'The Studio authoring request was canceled.');
    }
    const response = await readAuthoringResponse(queueRoot, runId);
    if (response) return response;
    const request = await readAuthoringRequest(queueRoot, runId);
    if (request && Date.parse(request.expiresAt) <= clock()) {
      throw new SmartUiError('TIMEOUT', 'The Studio authoring request expired before the agent responded.');
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

/** Removes a pending authoring request, e.g. when a run is canceled. */
export async function deleteAuthoringRequest(queueRoot: string, runId: string): Promise<void> {
  assertRunId(runId);
  await rm(join(queueRoot, REQUESTS_DIRNAME, `${runId}.json`), { force: true });
}

/** Removes a consumed authoring response. */
export async function deleteAuthoringResponse(queueRoot: string, runId: string): Promise<void> {
  assertRunId(runId);
  await rm(join(queueRoot, RESPONSES_DIRNAME, `${runId}.json`), { force: true });
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
  return error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ENOENT';
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
