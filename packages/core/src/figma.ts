import { createHash, randomUUID } from 'node:crypto';
import type { DesignProvider, ArtifactStore } from './providers.js';
import type { DesignContract, DesignElement } from './schemas.js';
import { designContractSchema } from './schemas.js';

export interface FigmaInput {
  fileKey: string;
  nodeId: string;
  name?: string;
}

export interface FigmaMcpClient {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export class FigmaDesignProvider implements DesignProvider<FigmaInput> {
  readonly name = 'figma-mcp';

  constructor(
    private readonly mcpClient: FigmaMcpClient,
    private readonly artifacts: ArtifactStore,
  ) {}

  async normalize(input: FigmaInput): Promise<DesignContract> {
    const contextResult = await this.mcpClient.callTool('get_design_context', {
      fileKey: input.fileKey,
      nodeId: input.nodeId,
    });

    const screenshotResult = (await this.mcpClient.callTool('get_screenshot', {
      fileKey: input.fileKey,
      nodeId: input.nodeId,
    })) as { imageBase64?: string; imageUrl?: string };

    let imageBytes: Uint8Array;
    if (screenshotResult.imageBase64) {
      imageBytes = Uint8Array.from(Buffer.from(screenshotResult.imageBase64, 'base64'));
    } else if (screenshotResult.imageUrl) {
      const res = await fetch(screenshotResult.imageUrl);
      imageBytes = new Uint8Array(await res.arrayBuffer());
    } else {
      imageBytes = new Uint8Array(0);
    }

    const sourceHash = `sha256:${createHash('sha256').update(imageBytes).digest('hex')}`;
    const reference = await this.artifacts.put(
      imageBytes,
      'image/png',
      `figma-${input.fileKey}-${input.nodeId}.png`,
    );

    const rawNode = (contextResult as { node?: unknown }).node || contextResult;
    const elements: DesignElement[] = [];

    const parseNode = (node: any, parentX = 0, parentY = 0) => {
      if (!node) return;
      const x = (node.x ?? 0) + parentX;
      const y = (node.y ?? 0) + parentY;

      const element: DesignElement = {
        validationId: node.validationId || node.id || undefined,
        figmaNodeId: node.id,
        type: (node.type || 'frame').toLowerCase(),
        x,
        y,
        width: node.width ?? undefined,
        height: node.height ?? undefined,
        color: node.color || undefined,
        backgroundColor: node.backgroundColor || undefined,
        borderColor: node.borderColor || undefined,
        borderWidth: node.borderWidth ?? undefined,
        borderRadius: node.borderRadius ?? undefined,
        opacity: node.opacity ?? undefined,
        boxShadow: node.boxShadow || undefined,
        fontFamily: node.fontFamily || undefined,
        fontSize: node.fontSize ?? undefined,
        fontWeight: node.fontWeight ?? undefined,
        lineHeight: node.lineHeight ?? undefined,
        letterSpacing: node.letterSpacing ?? undefined,
        text: node.characters || node.text || undefined,
      };

      elements.push(element);

      if (Array.isArray(node.children)) {
        for (const child of node.children) {
          parseNode(child, x, y);
        }
      }
    };

    parseNode(rawNode);

    const width = (rawNode as { width?: number }).width ?? 800;
    const height = (rawNode as { height?: number }).height ?? 600;

    return designContractSchema.parse({
      schemaVersion: '1.0',
      id: randomUUID(),
      name: input.name ?? (rawNode as { name?: string }).name ?? 'Figma design',
      viewport: {
        width,
        height,
        deviceScaleFactor: 1,
      },
      theme: 'light',
      locale: 'en-US',
      component: {
        name: (rawNode as { name?: string }).name ?? 'FixtureCard',
        route: '/',
      },
      reference,
      provenance: {
        provider: this.name,
        source: `figma://${input.fileKey}/${input.nodeId}`,
        capturedAt: new Date().toISOString(),
        sourceHash,
      },
      ambiguities: [],
      elements,
    });
  }
}

export class MockFigmaMcpClient implements FigmaMcpClient {
  private readonly responses = new Map<string, unknown>();

  setResponse(tool: string, args: Record<string, unknown>, response: unknown) {
    const key = `${tool}:${JSON.stringify(args)}`;
    this.responses.set(key, response);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const key = `${name}:${JSON.stringify(args)}`;
    if (this.responses.has(key)) {
      return this.responses.get(key);
    }
    if (name === 'get_design_context') {
      return {
        node: {
          id: '1:2',
          name: 'FixtureCard',
          type: 'FRAME',
          x: 0,
          y: 0,
          width: 420,
          height: 220,
          children: [
            {
              id: '1:3',
              name: 'eyebrow',
              type: 'TEXT',
              x: 40,
              y: 40,
              width: 100,
              height: 20,
              color: '#3d63dd',
              characters: 'SMART UI',
              fontSize: 12,
              fontWeight: 700,
            },
          ],
        },
      };
    }
    if (name === 'get_screenshot') {
      return {
        imageBase64: Buffer.from('mock-png-data').toString('base64'),
      };
    }
    throw new Error(`No mock response configured for tool ${name} with args ${JSON.stringify(args)}`);
  }
}
