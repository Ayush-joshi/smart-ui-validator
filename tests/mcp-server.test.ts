import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSmartUiMcpServer, MCP_TOOL_DEFINITIONS } from '../apps/mcp-server/src/server.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(closers.splice(0).map((close) => close())));

describe('stable host-neutral MCP contract', () => {
  it('discovers versioned tools, resources, prompts, annotations, and structured results', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createSmartUiMcpServer();
    const client = new Client({ name: 'contract-test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closers.push(
      () => client.close(),
      () => server.close(),
    );

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(
      MCP_TOOL_DEFINITIONS.map(([name]) => name).sort(),
    );
    expect(
      tools.tools.find((tool) => tool.name === 'inspect_project')?.annotations?.readOnlyHint,
    ).toBe(true);
    expect(tools.tools.find((tool) => tool.name === 'repair_component')?.annotations).toMatchObject(
      { readOnlyHint: false, destructiveHint: true },
    );
    expect(tools.tools.some((tool) => tool.name.includes('shell'))).toBe(false);
    expect((await client.listResources()).resources).toEqual(
      expect.arrayContaining([expect.objectContaining({ uri: 'smart-ui://capabilities' })]),
    );
    expect((await client.listPrompts()).prompts).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'implement-and-validate' })]),
    );

    const response = await client.callTool({
      name: 'inspect_project',
      arguments: { targetRoot: resolve('fixtures/angular-app') },
    });
    expect(response.structuredContent).toMatchObject({ framework: 'angular' });

    const denied = await client.callTool({
      name: 'inspect_project',
      arguments: { targetRoot: resolve('/') },
    });
    expect(denied.isError).toBe(true);
    expect(denied.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('MCP workspace root') }),
      ]),
    );
  });
});
