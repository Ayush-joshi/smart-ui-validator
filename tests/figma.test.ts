import { describe, expect, it } from 'vitest';
import {
  FigmaDesignProvider,
  MockFigmaMcpClient,
  LocalArtifactStore,
} from '../packages/core/src/index.js';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Figma Design Provider', () => {
  it('should call get_design_context & get_screenshot and normalize properties correctly', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'smart-ui-figma-test-'));
    const store = new LocalArtifactStore(tempDir);
    const mockMcp = new MockFigmaMcpClient();

    // Setup custom figma node context response
    mockMcp.setResponse('get_design_context', { fileKey: 'f1', nodeId: 'n1' }, {
      node: {
        id: '1:1',
        name: 'Button',
        type: 'FRAME',
        x: 0,
        y: 0,
        width: 120,
        height: 40,
        color: '#ffffff',
        backgroundColor: '#3d63dd',
        children: [
          {
            id: '1:2',
            name: 'label',
            type: 'TEXT',
            x: 10,
            y: 10,
            width: 100,
            height: 20,
            color: '#ffffff',
            characters: 'Submit',
            fontSize: 14,
            fontWeight: 600,
          }
        ]
      }
    });

    const provider = new FigmaDesignProvider(mockMcp, store);
    const contract = await provider.normalize({ fileKey: 'f1', nodeId: 'n1' });

    expect(contract.schemaVersion).toBe('1.0');
    expect(contract.name).toBe('Button');
    expect(contract.viewport.width).toBe(120);
    expect(contract.viewport.height).toBe(40);
    expect(contract.elements).toHaveLength(2);

    const frameEl = contract.elements[0]!;
    expect(frameEl.type).toBe('frame');
    expect(frameEl.backgroundColor).toBe('#3d63dd');

    const textEl = contract.elements[1]!;
    expect(textEl.type).toBe('text');
    expect(textEl.text).toBe('Submit');
    expect(textEl.fontSize).toBe(14);
    expect(textEl.fontWeight).toBe(600);
  });
});
