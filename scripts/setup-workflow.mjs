#!/usr/bin/env node
import { access, copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { parseArgs } from 'node:util';

const validatorRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mcpEntry = join(validatorRoot, 'apps', 'mcp-server', 'dist', 'index.js');
const args = process.argv.slice(2);
if (args[0] === '--') args.shift();
const { values } = parseArgs({
  args,
  options: {
    target: { type: 'string', short: 't' },
    design: { type: 'string', short: 'd' },
    url: { type: 'string', short: 'u' },
    spec: { type: 'string' },
    component: { type: 'string' },
    selector: { type: 'string' },
    host: { type: 'string', default: 'codex' },
    memory: { type: 'boolean', default: false },
    'ensure-engine': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
});

if (values.help) {
  printHelp();
  process.exit(0);
}

const missing = ['target', 'design', 'url'].filter((name) => !values[name]);
if (missing.length) {
  console.error(`Missing required option(s): ${missing.map((name) => `--${name}`).join(', ')}`);
  printHelp();
  process.exit(2);
}

if (!['codex', 'claude', 'copilot'].includes(values.host)) {
  console.error('--host must be codex, claude, or copilot.');
  process.exit(2);
}

const targetRoot = resolve(values.target);
const designSource = resolve(values.design);
const specSource = values.spec ? resolve(values.spec) : undefined;
const route = parseRoute(values.url);
if (values['ensure-engine']) await ensureEngine();
await requireDirectory(targetRoot, 'Target');
await requireFile(join(targetRoot, 'package.json'), 'Target package.json');
await requireFile(designSource, 'Design');
if (specSource) await requireFile(specSource, 'Design sidecar');

const workflowRoot = join(targetRoot, '.smart-ui');
const designRoot = join(workflowRoot, 'design');
const designPath = join(
  designRoot,
  safeEvidenceName(designSource, 'reference', ['.png', '.jpg', '.jpeg', '.webp', '.svg']),
);
const specPath = specSource
  ? join(designRoot, safeEvidenceName(specSource, 'reference-spec', ['.json']))
  : null;
const artifactRoot = join(workflowRoot, 'artifacts');
const contractPath = join(workflowRoot, 'design-contract.json');
const manifestPath = join(workflowRoot, 'workflow.json');
const instructionsPath = join(workflowRoot, 'AGENT_WORKFLOW.md');
const hostConfigPath = join(workflowRoot, hostConfigName(values.host));
const manifest = {
  schemaVersion: '1.0',
  targetRoot,
  route,
  design: {
    imagePath: designPath,
    ...(specPath ? { specPath } : {}),
  },
  artifactRoot,
  contractPath,
  ...(values.component ? { componentId: values.component } : {}),
  ...(values.selector ? { selector: values.selector } : {}),
  memory: { enabled: values.memory },
};
const instructions = agentInstructions(manifestPath, manifest);
const hostConfig = hostConfiguration(values.host, targetRoot);

if (!values['dry-run']) {
  await mkdir(designRoot, { recursive: true });
  await mkdir(artifactRoot, { recursive: true });
  await copyIdempotently(designSource, designPath);
  if (specSource && specPath) await copyIdempotently(specSource, specPath);
  await writeIdempotently(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeIdempotently(instructionsPath, instructions);
  await writeIdempotently(hostConfigPath, hostConfig);
}

const mcpBuilt = await isMcpCurrent();
console.log(
  JSON.stringify(
    {
      ready: mcpBuilt,
      dryRun: values['dry-run'],
      targetRoot,
      manifestPath,
      instructionsPath,
      hostConfigPath,
      mcpEntry,
      ...(mcpBuilt
        ? {}
        : {
            requiredCommand:
              'Run this setup command again with --ensure-engine to install/build missing engine requirements.',
          }),
      nextSteps: [
        mcpBuilt
          ? 'Merge the generated host config once if Smart UI is not already connected, then restart the host.'
          : 'Build Smart UI, merge the generated host config once, then restart the host.',
        `Ask the agent: Read ${instructionsPath} and call prepare_workflow with ${manifestPath}.`,
      ],
    },
    null,
    2,
  ),
);

function printHelp() {
  console.log(`Usage:
  pnpm workflow:setup -- --target <project> --design <image-or-svg> --url <local-url> [options]

Options:
  --spec <json>          Optional semantic design sidecar
  --component <name>    Component identity for validation and memory scope
  --selector <selector> Browser selector for component/state targeting
  --host <name>         codex (default), claude, or copilot
  --memory              Enable governed memory recall in suggested validation arguments
  --ensure-engine       Install missing dependencies/Chromium and build stale engine output
  --dry-run             Validate inputs and preview output without writing
  --help                 Show this help
`);
}

function parseRoute(input) {
  try {
    const parsed = new URL(input);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol');
    return parsed.href;
  } catch {
    console.error('--url must be a fully qualified HTTP or HTTPS URL.');
    process.exit(2);
  }
}

async function requireDirectory(path, label) {
  const details = await stat(path).catch(() => null);
  if (!details?.isDirectory()) {
    console.error(`${label} must be an existing directory: ${path}`);
    process.exit(2);
  }
}

async function requireFile(path, label) {
  const details = await stat(path).catch(() => null);
  if (!details?.isFile()) {
    console.error(`${label} must be an existing file: ${path}`);
    process.exit(2);
  }
}

function safeEvidenceName(path, fallback, supported) {
  const extension = extname(path).toLowerCase();
  if (!supported.includes(extension)) {
    console.error(`Unsupported evidence extension: ${extension || '(none)'}`);
    process.exit(2);
  }
  const stem = basename(path, extension)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${stem || fallback}${extension}`;
}

async function copyIdempotently(source, destination) {
  if (await exists(destination)) {
    const [existing, incoming] = await Promise.all([readFile(destination), readFile(source)]);
    if (!existing.equals(incoming)) {
      throw new Error(`Refusing to overwrite different workflow evidence: ${destination}`);
    }
    return;
  }
  await copyFile(source, destination);
}

async function writeIdempotently(path, content) {
  if (await exists(path)) {
    if ((await readFile(path, 'utf8')) !== content) {
      throw new Error(`Refusing to overwrite different workflow state: ${path}`);
    }
    return;
  }
  await writeFile(path, content, { flag: 'wx' });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isMcpCurrent() {
  const entryDetails = await stat(mcpEntry).catch(() => null);
  if (!entryDetails) return false;
  const sourceTimes = await Promise.all([
    newestModifiedTime(join(validatorRoot, 'apps', 'mcp-server', 'src')),
    newestModifiedTime(join(validatorRoot, 'packages', 'core', 'src')),
    newestModifiedTime(join(validatorRoot, 'package.json')),
    newestModifiedTime(join(validatorRoot, 'pnpm-lock.yaml')),
  ]);
  return entryDetails.mtimeMs >= Math.max(...sourceTimes);
}

async function newestModifiedTime(path) {
  const details = await stat(path).catch(() => null);
  if (!details) return 0;
  if (!details.isDirectory()) return details.mtimeMs;
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => newestModifiedTime(join(path, entry.name))),
  );
  return Math.max(details.mtimeMs, ...nested);
}

async function ensureEngine() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if ((major ?? 0) < 22 || ((major ?? 0) === 22 && (minor ?? 0) < 16)) {
    throw new Error(`Node.js 22.16 or newer is required; found ${process.versions.node}.`);
  }
  runPnpm(['install', '--frozen-lockfile']);
  runPnpm(['--filter', 'smart-ui-validator-core', 'exec', 'playwright', 'install', 'chromium']);
  if (!(await isMcpCurrent())) runPnpm(['build']);
}

function runPnpm(arguments_) {
  const result = spawnSync('pnpm', arguments_, { cwd: validatorRoot, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `pnpm ${arguments_.join(' ')} failed with exit code ${result.status ?? 'unknown'}.`,
    );
  }
}

function hostConfigName(host) {
  if (host === 'codex') return 'codex-mcp.toml';
  if (host === 'claude') return 'claude-mcp.json';
  return 'copilot-mcp.json';
}

function hostConfiguration(host, target) {
  if (host === 'codex') {
    return `[mcp_servers.smart_ui]\ncommand = "node"\nargs = [${JSON.stringify(mcpEntry)}]\ncwd = ${JSON.stringify(target)}\nstartup_timeout_sec = 20\ntool_timeout_sec = 120\nrequired = true\nenabled = true\ndefault_tools_approval_mode = "writes"\n\n[mcp_servers.smart_ui.tools.repair_component]\napproval_mode = "prompt"\n\n[mcp_servers.smart_ui.tools.confirm_memory]\napproval_mode = "prompt"\n\n[mcp_servers.smart_ui.tools.forget_memory]\napproval_mode = "prompt"\n`;
  }
  if (host === 'claude') {
    return `${JSON.stringify(
      {
        mcpServers: {
          'smart-ui': {
            type: 'stdio',
            command: 'node',
            args: [mcpEntry],
            env: { SMART_UI_MCP_ROOT: target },
          },
        },
      },
      null,
      2,
    )}\n`;
  }
  return `${JSON.stringify(
    {
      servers: {
        'smart-ui': {
          type: 'stdio',
          command: 'node',
          args: [mcpEntry],
          env: { SMART_UI_MCP_ROOT: target },
        },
      },
    },
    null,
    2,
  )}\n`;
}

function agentInstructions(manifestPath, manifest) {
  return `# Smart UI target workflow\n\nThis file was generated by \`pnpm workflow:setup\`. Do not rediscover or rewrite these paths.\n\n## First agent action\n\nCall \`prepare_workflow\` once with:\n\n\`\`\`json\n${JSON.stringify({ manifestPath }, null, 2)}\n\`\`\`\n\nThat call inspects the project, normalizes the design if necessary, persists the contract, and returns ready-to-use compact \`validate_component\` arguments.\n\n## Fixed session inputs\n\n- Target: \`${manifest.targetRoot}\`\n- URL: \`${manifest.route}\`\n- Design: \`${manifest.design.imagePath}\`\n- Contract: \`${manifest.contractPath}\`\n- Artifact root: \`${manifest.artifactRoot}\`\n${manifest.componentId ? `- Component: \`${manifest.componentId}\`\n` : ''}${manifest.selector ? `- Selector: \`${manifest.selector}\`\n` : ''}\n## Agent rules\n\n1. Check the configured URL once. Start the target dev server only if it is not already reachable; do not spawn duplicate listeners.\n2. Reuse the returned \`designContractPath\` and \`artifactRoot\` for every validation and repair in this session.\n3. Use \`responseDetail=compact\`. Call \`get_run\` or use full detail only when sampled findings and report artifacts are insufficient.\n4. Validate before editing. Before repair, inspect/plan the named component and request approval for exact target-relative files.\n5. Track \`visualSimilarityPercent\` for convergence; \`checkScore\` remains binary until each threshold passes.\n6. Treat expected runtime states explicitly. Do not use memory to suppress a 401, console error, failed request, or accessibility failure.\n7. Only propose compact, reusable preferences to memory. Confirmation is required; never store screenshots, DOM/CSS dumps, scores, secrets, or permissions.\n8. Stop when validation passes, bounded repair stops, or user input is materially required. Return report paths instead of echoing full records.\n`;
}
