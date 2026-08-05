import { createHash, randomUUID } from 'node:crypto';
import type { ArtifactStore, DesignProvider } from './providers.js';
import { SmartUiError } from './errors.js';
import { redactSensitiveText, redactSensitiveValue } from './security.js';
import {
  designContractSchema,
  type ArtifactRef,
  type DesignContract,
  type DesignElement,
} from './schemas.js';

export interface FigmaInput {
  fileKey: string;
  nodeId: string;
  name?: string;
}

export interface McpTextContent {
  type: 'text';
  text: string;
}

export interface McpImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface McpCallToolResult {
  content?: Array<McpTextContent | McpImageContent | { type: string; [key: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface FigmaMcpClient {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface FigmaProviderOptions {
  fetchBinary?: (url: string) => Promise<{ bytes: Uint8Array; mediaType: string }>;
  maxBinaryBytes?: number;
}

export class FigmaDesignProvider implements DesignProvider<FigmaInput> {
  readonly name = 'figma-mcp';
  private readonly maxBinaryBytes: number;

  constructor(
    private readonly mcpClient: FigmaMcpClient,
    private readonly artifacts: ArtifactStore,
    private readonly options: FigmaProviderOptions = {},
  ) {
    this.maxBinaryBytes = options.maxBinaryBytes ?? 20_000_000;
  }

  async normalize(input: FigmaInput): Promise<DesignContract> {
    const args = { fileKey: input.fileKey, nodeId: input.nodeId };
    const uncertainties: string[] = [];
    const metadata = await this.safeCall('get_metadata', args, uncertainties, true);
    const context = await this.safeCall('get_design_context', args, uncertainties, true);
    const variables = await this.safeCall('get_variable_defs', args, uncertainties, false);
    const codeConnect = await this.safeCall('get_code_connect_map', args, uncertainties, false);
    const screenshotResult = await this.safeCall(
      'get_screenshot',
      { ...args, enableBase64Response: true },
      uncertainties,
      true,
    );

    const screenshot = await this.readImage(screenshotResult, 'Figma screenshot');
    const reference = await this.artifacts.put(
      screenshot.bytes,
      screenshot.mediaType,
      `figma-${safeLabel(input.fileKey)}-${safeLabel(input.nodeId)}.png`,
    );
    const layoutContext = await this.storeMcpEvidence(context, 'figma-layout-context.json');
    const variablesArtifact = variables
      ? await this.storeMcpEvidence(variables, 'figma-variables.json')
      : undefined;
    const codeConnectArtifact = codeConnect
      ? await this.storeMcpEvidence(codeConnect, 'figma-code-connect.json')
      : undefined;
    const assetArtifacts = await this.storeDiscoveredAssets(context, uncertainties);
    const elements = extractDesignElements(metadata, context);
    if (elements.length === 0) {
      uncertainties.push(
        'Figma evidence did not expose structured element geometry; no measurements were fabricated.',
      );
    }
    const root = elements[0];
    const structured = firstStructured(metadata) ?? firstStructured(context);
    const sourceVersion = stringProperty(structured, 'version');
    const metadataName = rootNameFromMetadata(metadata);

    return designContractSchema.parse({
      schemaVersion: '1.0',
      id: randomUUID(),
      name:
        input.name ??
        stringProperty(structured, 'name') ??
        metadataName ??
        root?.validationId ??
        'Figma design',
      viewport: {
        width: root?.width ?? screenshot.width ?? 800,
        height: root?.height ?? screenshot.height ?? 600,
        deviceScaleFactor: 1,
      },
      theme: 'light',
      locale: 'en-US',
      component: {
        name:
          stringProperty(structured, 'name') ??
          metadataName ??
          root?.validationId ??
          'FigmaComponent',
        route: '/',
      },
      reference,
      provenance: {
        provider: this.name,
        source: `figma://${input.fileKey}/${input.nodeId}`,
        capturedAt: new Date().toISOString(),
        sourceHash: hashBytes(screenshot.bytes),
        ...(sourceVersion ? { sourceVersion } : {}),
        documentId: input.fileKey,
        nodeId: input.nodeId,
      },
      ambiguities: [],
      elements,
      sourceEvidence: {
        layoutContext,
        ...(variablesArtifact ? { variables: variablesArtifact } : {}),
        ...(codeConnectArtifact ? { codeConnect: codeConnectArtifact } : {}),
        assets: assetArtifacts,
        uncertainties,
      },
    });
  }

  private async safeCall(
    tool: string,
    args: Record<string, unknown>,
    uncertainties: string[],
    required: boolean,
  ): Promise<unknown> {
    try {
      const result = await this.mcpClient.callTool(tool, args);
      if (isCallToolResult(result) && result.isError)
        throw new Error(`${tool} returned an MCP error.`);
      return result;
    } catch (error) {
      if (required) {
        throw new SmartUiError(
          'PROVIDER_FAILURE',
          `Required Figma MCP tool ${tool} failed: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`,
          { provider: this.name },
        );
      }
      uncertainties.push(`Optional Figma MCP tool ${tool} was unavailable.`);
      return undefined;
    }
  }

  private async readImage(
    result: unknown,
    label: string,
  ): Promise<{ bytes: Uint8Array; mediaType: string; width?: number; height?: number }> {
    const callResult = isCallToolResult(result) ? result : undefined;
    const imageContent = callResult?.content?.find(
      (item): item is McpImageContent => item.type === 'image',
    );
    if (imageContent) return this.boundedImage(imageContent.data, imageContent.mimeType, label);
    const structured = firstStructured(result);
    const base64 = stringProperty(structured, 'imageBase64') ?? stringProperty(structured, 'data');
    if (base64) {
      return this.boundedImage(
        base64.replace(/^data:[^;]+;base64,/, ''),
        stringProperty(structured, 'mediaType') ?? 'image/png',
        label,
      );
    }
    const url = stringProperty(structured, 'imageUrl') ?? stringProperty(structured, 'url');
    if (url && this.options.fetchBinary) {
      const fetched = await this.options.fetchBinary(url);
      this.assertSize(fetched.bytes, label);
      return fetched;
    }
    throw new SmartUiError(
      'PROVIDER_FAILURE',
      `${label} contained neither MCP image content nor an approved fetchable URL.`,
      { provider: this.name },
    );
  }

  private boundedImage(
    data: string,
    mediaType: string,
    label: string,
  ): { bytes: Uint8Array; mediaType: string } {
    const bytes = Uint8Array.from(Buffer.from(data, 'base64'));
    this.assertSize(bytes, label);
    if (bytes.length === 0) throw new SmartUiError('PROVIDER_FAILURE', `${label} was empty.`);
    return { bytes, mediaType };
  }

  private assertSize(bytes: Uint8Array, label: string): void {
    if (bytes.byteLength > this.maxBinaryBytes) {
      throw new SmartUiError(
        'PROVIDER_FAILURE',
        `${label} exceeds the ${this.maxBinaryBytes} byte budget.`,
      );
    }
  }

  private async storeMcpEvidence(result: unknown, label: string): Promise<ArtifactRef> {
    const bytes = new TextEncoder().encode(
      `${JSON.stringify(redactSensitiveValue(result), null, 2)}\n`,
    );
    return this.artifacts.put(bytes, 'application/json', label);
  }

  private async storeDiscoveredAssets(
    result: unknown,
    uncertainties: string[],
  ): Promise<ArtifactRef[]> {
    const urls = discoverUrls(firstStructured(result)).slice(0, 20);
    if (urls.length === 0) return [];
    if (!this.options.fetchBinary) {
      uncertainties.push(
        'Figma asset URLs were recorded in layout context but not fetched without an approved binary fetcher.',
      );
      return [];
    }
    const stored: ArtifactRef[] = [];
    for (const [index, url] of urls.entries()) {
      try {
        const asset = await this.options.fetchBinary(url);
        this.assertSize(asset.bytes, `Figma asset ${index}`);
        stored.push(await this.artifacts.put(asset.bytes, asset.mediaType, `figma-asset-${index}`));
      } catch {
        uncertainties.push(
          `Figma asset ${index} could not be fetched through the approved boundary.`,
        );
      }
    }
    return stored;
  }
}

export class MockFigmaMcpClient implements FigmaMcpClient {
  private readonly responses = new Map<string, unknown>();

  setResponse(tool: string, args: Record<string, unknown>, response: unknown): void {
    this.responses.set(keyFor(tool, args), response);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const configured = this.responses.get(keyFor(name, args));
    if (configured !== undefined) return configured;
    if (name === 'get_metadata') {
      return {
        content: [
          {
            type: 'text',
            text: '<frame id="1:2" name="FixtureCard" x="0" y="0" width="420" height="220"><text id="1:3" name="eyebrow" x="40" y="40" width="100" height="20" /></frame>',
          },
        ],
      } satisfies McpCallToolResult;
    }
    if (name === 'get_design_context') {
      return {
        content: [{ type: 'text', text: 'export function FixtureCard() {}' }],
      } satisfies McpCallToolResult;
    }
    if (name === 'get_variable_defs' || name === 'get_code_connect_map') {
      return { structuredContent: {} } satisfies McpCallToolResult;
    }
    if (name === 'get_screenshot') {
      return {
        content: [
          {
            type: 'image',
            data: Buffer.from('mock-png-data').toString('base64'),
            mimeType: 'image/png',
          },
        ],
      } satisfies McpCallToolResult;
    }
    throw new Error(`No mock response configured for ${name}.`);
  }
}

function extractDesignElements(metadata: unknown, context: unknown): DesignElement[] {
  const structured = firstStructured(metadata) ?? firstStructured(context);
  const root = recordProperty(structured, 'node') ?? structured;
  if (isRecord(root) && (stringProperty(root, 'id') || Array.isArray(root.children))) {
    const elements: DesignElement[] = [];
    walkNode(root, elements);
    return elements;
  }
  const text = textContent(metadata);
  return text ? parseMetadataXml(text) : [];
}

function walkNode(node: Record<string, unknown>, elements: DesignElement[]): void {
  const id = stringProperty(node, 'id');
  const type = stringProperty(node, 'type')?.toLowerCase() ?? 'frame';
  const name = stringProperty(node, 'name');
  elements.push({
    ...(id ? { validationId: id, figmaNodeId: id } : {}),
    type,
    ...(numberProperty(node, 'x') !== undefined ? { x: numberProperty(node, 'x') } : {}),
    ...(numberProperty(node, 'y') !== undefined ? { y: numberProperty(node, 'y') } : {}),
    ...(numberProperty(node, 'width') !== undefined
      ? { width: numberProperty(node, 'width') }
      : {}),
    ...(numberProperty(node, 'height') !== undefined
      ? { height: numberProperty(node, 'height') }
      : {}),
    ...(name && type === 'text' ? { text: name } : {}),
  });
  const children = node.children;
  if (Array.isArray(children)) {
    for (const child of children) if (isRecord(child)) walkNode(child, elements);
  }
}

function parseMetadataXml(xml: string): DesignElement[] {
  const elements: DesignElement[] = [];
  const tagPattern = /<([a-zA-Z][\w-]*)\s+([^>]*?)(?:\/?>)/g;
  for (const match of xml.matchAll(tagPattern)) {
    const attributes = Object.fromEntries(
      [...(match[2] ?? '').matchAll(/([\w-]+)="([^"]*)"/g)].map((attribute) => [
        attribute[1]!,
        attribute[2]!,
      ]),
    );
    const id = attributes['id'];
    if (!id) continue;
    elements.push({
      validationId: id,
      figmaNodeId: id,
      type: (match[1] ?? 'frame').toLowerCase(),
      ...(toNumber(attributes['x']) !== undefined ? { x: toNumber(attributes['x']) } : {}),
      ...(toNumber(attributes['y']) !== undefined ? { y: toNumber(attributes['y']) } : {}),
      ...(toNumber(attributes['width']) !== undefined
        ? { width: toNumber(attributes['width']) }
        : {}),
      ...(toNumber(attributes['height']) !== undefined
        ? { height: toNumber(attributes['height']) }
        : {}),
    });
  }
  return elements;
}

function firstStructured(result: unknown): unknown {
  if (isCallToolResult(result) && result.structuredContent !== undefined)
    return result.structuredContent;
  return result;
}

function textContent(result: unknown): string | undefined {
  if (!isCallToolResult(result)) return undefined;
  return result.content
    ?.filter(
      (item): item is McpTextContent => item.type === 'text' && typeof item.text === 'string',
    )
    .map((item) => item.text)
    .join('\n');
}

function rootNameFromMetadata(result: unknown): string | undefined {
  const text = textContent(result);
  return text?.match(/<[a-zA-Z][\w-]*\s+[^>]*name="([^"]+)"/)?.[1];
}

function isCallToolResult(value: unknown): value is McpCallToolResult {
  return (
    isRecord(value) && ('content' in value || 'structuredContent' in value || 'isError' in value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordProperty(value: unknown, key: string): Record<string, unknown> | undefined {
  return isRecord(value) && isRecord(value[key]) ? value[key] : undefined;
}

function stringProperty(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === 'string' ? value[key] : undefined;
}

function numberProperty(value: unknown, key: string): number | undefined {
  return isRecord(value) && typeof value[key] === 'number' && Number.isFinite(value[key])
    ? value[key]
    : undefined;
}

function discoverUrls(value: unknown, found = new Set<string>()): string[] {
  if (typeof value === 'string' && /^https?:\/\//.test(value)) found.add(value);
  else if (Array.isArray(value)) for (const item of value) discoverUrls(item, found);
  else if (isRecord(value)) for (const item of Object.values(value)) discoverUrls(item, found);
  return [...found];
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hashBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function safeLabel(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

function keyFor(tool: string, args: Record<string, unknown>): string {
  return `${tool}:${JSON.stringify(args)}`;
}
