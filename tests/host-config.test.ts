import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('host setup contracts', () => {
  it('routes Claude Code and Copilot through the same stdio MCP server', async () => {
    const claude = JSON.parse(await readFile('examples/hosts/claude-code/.mcp.json', 'utf8'));
    const copilot = JSON.parse(await readFile('examples/hosts/copilot/.vscode/mcp.json', 'utf8'));
    expect(claude.mcpServers['smart-ui']).toMatchObject({ type: 'stdio', command: 'node' });
    expect(copilot.servers['smart-ui']).toMatchObject({
      type: 'stdio',
      command: 'node',
      sandboxEnabled: true,
    });
    expect(claude.mcpServers['smart-ui'].args[0]).toContain('apps/mcp-server/dist/index.js');
    expect(copilot.servers['smart-ui'].args[0]).toContain('apps/mcp-server/dist/index.js');
  });

  it('keeps Codex mutating tools approval-gated and OpenClaw disabled by default', async () => {
    const codex = await readFile('examples/hosts/codex/.codex/config.toml', 'utf8');
    const openClaw = JSON.parse(
      await readFile('examples/hosts/openclaw/openclaw.example.json', 'utf8'),
    );
    expect(codex).toContain('default_tools_approval_mode = "writes"');
    expect(codex).toContain('[mcp_servers.smart_ui.tools.repair_component]');
    expect(openClaw.smartUi.enabled).toBe(false);
    expect(openClaw.smartUi.outputPolicy.allowSource).toBe(false);
  });
});
