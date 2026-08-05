import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FigmaDesignProvider,
  LocalArtifactStore,
  MockFigmaMcpClient,
} from '../packages/core/src/index.js';
import { PNG_BYTES } from './helpers.js';

describe('Figma MCP design provider contract', () => {
  it('normalizes recorded MCP content blocks with provenance and optional evidence', async () => {
    const store = new LocalArtifactStore(await mkdtemp(join(tmpdir(), 'smart-ui-figma-')));
    const client = new MockFigmaMcpClient();
    const args = { fileKey: 'file-1', nodeId: '1:1' };
    client.setResponse('get_metadata', args, {
      content: [
        {
          type: 'text',
          text: '<frame id="1:1" name="Button" x="0" y="0" width="120" height="40"><text id="1:2" name="Label" x="10" y="10" width="100" height="20" /></frame>',
        },
      ],
    });
    client.setResponse('get_design_context', args, {
      content: [
        {
          type: 'text',
          text: 'export function Button() { return <button>Submit</button>; } Authorization: Bearer fixture',
        },
      ],
    });
    client.setResponse('get_variable_defs', args, {
      structuredContent: { '--brand': '#3d63dd' },
    });
    client.setResponse('get_code_connect_map', args, {
      structuredContent: { '1:1': { componentName: 'Button', source: 'src/Button.tsx' } },
    });
    client.setResponse(
      'get_screenshot',
      { ...args, enableBase64Response: true },
      {
        content: [
          { type: 'image', data: Buffer.from(PNG_BYTES).toString('base64'), mimeType: 'image/png' },
        ],
      },
    );

    const result = await new FigmaDesignProvider(client, store).normalize({
      fileKey: 'file-1',
      nodeId: '1:1',
    });
    expect(result.name).toBe('Button');
    expect(result.viewport).toMatchObject({ width: 120, height: 40 });
    expect(result.elements).toHaveLength(2);
    expect(result.provenance).toMatchObject({
      provider: 'figma-mcp',
      documentId: 'file-1',
      nodeId: '1:1',
    });
    expect(result.sourceEvidence.variables?.mediaType).toBe('application/json');
    expect(result.sourceEvidence.codeConnect?.mediaType).toBe('application/json');
    const storedContext = new TextDecoder().decode(
      await store.read(result.sourceEvidence.layoutContext!.relativePath),
    );
    expect(storedContext).not.toContain('Bearer fixture');
    expect(() => JSON.parse(storedContext)).not.toThrow();
  });

  it('rejects an empty or malformed screenshot response', async () => {
    const store = new LocalArtifactStore(await mkdtemp(join(tmpdir(), 'smart-ui-figma-')));
    const client = new MockFigmaMcpClient();
    client.setResponse(
      'get_screenshot',
      { fileKey: 'bad', nodeId: '1:1', enableBase64Response: true },
      { structuredContent: {} },
    );
    await expect(
      new FigmaDesignProvider(client, store).normalize({ fileKey: 'bad', nodeId: '1:1' }),
    ).rejects.toThrow(/neither MCP image content/);
  });
});
