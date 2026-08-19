import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';

const requiredGenerationTools = [
  'inspect_svg',
  'generate_html_from_svg',
  'export_generation',
  'get_generation',
  'get_generation_report',
];
const requiredStudioTools = ['list_studio_authoring_requests', 'submit_studio_authored_html'];
const requiredHandoffTools = [
  'list_handoff_tasks',
  'get_handoff_task',
  'read_handoff_evidence',
  'submit_handoff_generation',
  'submit_handoff_implementation',
];
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve('apps/mcp-server/dist/index.js')],
  cwd: process.cwd(),
  stderr: 'pipe',
});
const client = new Client({ name: 'smart-ui-built-transport-check', version: '1.0.0' });

try {
  await client.connect(transport);
  const [tools, resources, templates, prompts] = await Promise.all([
    client.listTools(),
    client.listResources(),
    client.listResourceTemplates(),
    client.listPrompts(),
  ]);
  const names = new Set(tools.tools.map((tool) => tool.name));
  for (const name of requiredGenerationTools) {
    if (!names.has(name)) throw new Error(`Built MCP server is missing ${name}.`);
  }
  for (const name of requiredStudioTools) {
    if (!names.has(name)) throw new Error(`Built MCP server is missing ${name}.`);
  }
  for (const name of requiredHandoffTools) {
    if (!names.has(name)) throw new Error(`Built MCP server is missing ${name}.`);
  }
  if (!resources.resources.some((resource) => resource.uri === 'smart-ui://svg-generation-guide')) {
    throw new Error('Built MCP server is missing the SVG generation guide.');
  }
  if (
    !templates.resourceTemplates.some(
      (resource) =>
        resource.uriTemplate === 'smart-ui://generation-context/{generationId}/{cursor}',
    )
  ) {
    throw new Error('Built MCP server is missing the paged generation-context resource.');
  }
  if (!prompts.prompts.some((prompt) => prompt.name === 'generate-from-svg')) {
    throw new Error('Built MCP server is missing the generate-from-svg prompt.');
  }
  process.stdout.write(
    `${JSON.stringify({ tools: tools.tools.length, generationTools: requiredGenerationTools.length, studioTools: requiredStudioTools.length, handoffTools: requiredHandoffTools.length, stdio: true })}\n`,
  );
} finally {
  await client.close();
}
