import { createServer } from 'node:http';
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { probeChromium } from './doctor.js';
import { redactSensitiveValue } from './security.js';

export type StudioAgentHost = 'codex' | 'claude' | 'copilot';

export interface StudioAgentSetupCheck {
  name:
    | 'node'
    | 'mcp-root'
    | 'mcp-build'
    | 'studio-assets'
    | 'chromium'
    | 'workspace'
    | 'host-config'
    | 'loopback';
  status: 'pass' | 'warn' | 'fail';
  message: string;
  recovery?: string;
}

export interface StudioAgentSetupOptions {
  workspaceRoot: string;
  mcpRoot: string;
  mcpEntryPath: string;
  studioAssetsRoot: string;
  host: StudioAgentHost;
  hostConfigPath: string;
  expectedHostConfig: string;
  sourcePaths?: string[];
  skipChromiumProbe?: boolean;
}

export interface StudioAgentSetupResult {
  schemaVersion: '1.0';
  ready: boolean;
  checks: StudioAgentSetupCheck[];
}

/** Shared, read-only Studio-agent diagnostics used by both bootstrap and doctor. */
export async function runStudioAgentSetupChecks(
  options: StudioAgentSetupOptions,
): Promise<StudioAgentSetupResult> {
  const checks: StudioAgentSetupCheck[] = [];
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  checks.push({
    name: 'node',
    status: major > 22 || (major === 22 && minor >= 16) ? 'pass' : 'fail',
    message: `Node ${process.versions.node}; required >=22.16.`,
    ...(!(major > 22 || (major === 22 && minor >= 16))
      ? { recovery: 'Install Node.js 22.16 or newer, then rerun the same command.' }
      : {}),
  });

  const rootCheck = await checkMcpRoot(options.mcpRoot, options.workspaceRoot);
  checks.push(rootCheck);
  checks.push(await checkMcpBuild(options.mcpEntryPath, options.sourcePaths));
  checks.push(await checkStudioAssets(options.studioAssetsRoot));
  checks.push(await checkWorkspace(options.workspaceRoot, rootCheck.status === 'pass'));
  checks.push(await checkHostConfig(options));
  checks.push(await checkLoopback());
  if (options.skipChromiumProbe) {
    checks.push({
      name: 'chromium',
      status: 'warn',
      message: 'Chromium launch was not probed.',
      recovery: 'Rerun without the check-only browser skip before starting Studio.',
    });
  } else {
    try {
      await probeChromium();
      checks.push({ name: 'chromium', status: 'pass', message: 'Pinned Chromium launches.' });
    } catch {
      checks.push({
        name: 'chromium',
        status: 'fail',
        message: 'Pinned Chromium did not launch.',
        recovery: 'Rerun with --ensure-engine to install the pinned Chromium revision.',
      });
    }
  }
  const redacted = redactSensitiveValue(checks) as StudioAgentSetupCheck[];
  return {
    schemaVersion: '1.0',
    ready: !redacted.some((check) => check.status === 'fail'),
    checks: redacted,
  };
}

/** Creates an absent host config atomically and never overwrites a differing file. */
export async function ensureStudioAgentHostConfig(
  path: string,
  expected: string,
  dryRun = false,
): Promise<'created' | 'unchanged' | 'would-create' | 'different'> {
  try {
    return (await readFile(path, 'utf8')) === expected ? 'unchanged' : 'different';
  } catch (error) {
    if (!missing(error)) throw error;
  }
  if (dryRun) return 'would-create';
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, expected, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
    return 'created';
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function checkMcpRoot(
  mcpRootValue: string,
  workspaceValue: string,
): Promise<StudioAgentSetupCheck> {
  const mcpRoot = resolve(mcpRootValue);
  const workspace = resolve(workspaceValue);
  const unsafe = mcpRoot === resolve('/') || mcpRoot === resolve(homedir());
  const relation = relative(mcpRoot, workspace);
  if (unsafe || relation.startsWith('..') || isAbsolute(relation) || workspace === mcpRoot) {
    return {
      name: 'mcp-root',
      status: 'fail',
      message: 'The MCP root is broad or does not contain the dedicated Studio workspace.',
      recovery:
        'Set SMART_UI_MCP_ROOT to the project root that contains the dedicated Studio workspace.',
    };
  }
  try {
    const details = await lstat(mcpRoot);
    if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('not regular');
    const realRoot = await realpath(mcpRoot);
    const existingParent = await nearestExistingParent(workspace);
    const realParent = await realpath(existingParent);
    const realRelation = relative(realRoot, realParent);
    if (realRelation.startsWith('..') || isAbsolute(realRelation)) throw new Error('escaped');
  } catch {
    return {
      name: 'mcp-root',
      status: 'fail',
      message: 'The MCP root or workspace containment path is invalid.',
      recovery:
        'Choose an existing regular project directory as SMART_UI_MCP_ROOT and keep the Studio workspace inside it.',
    };
  }
  return { name: 'mcp-root', status: 'pass', message: 'MCP root containment is valid.' };
}

async function checkMcpBuild(
  entryPath: string,
  sourcePaths?: string[],
): Promise<StudioAgentSetupCheck> {
  const entry = await stat(entryPath).catch(() => undefined);
  if (!entry?.isFile()) {
    return {
      name: 'mcp-build',
      status: 'fail',
      message: 'The built MCP server entrypoint is missing.',
      recovery: 'Rerun with --ensure-engine to build the MCP server, then restart the host.',
    };
  }
  if (sourcePaths && sourcePaths.length > 0) {
    const newestSource = Math.max(...(await Promise.all(sourcePaths.map(newestModifiedTime))));
    if (entry.mtimeMs < newestSource) {
      return {
        name: 'mcp-build',
        status: 'fail',
        message: 'The built MCP server is older than its source.',
        recovery: 'Rerun with --ensure-engine to rebuild, then restart the host process.',
      };
    }
  }
  return {
    name: 'mcp-build',
    status: 'pass',
    message: 'The MCP server build is present and current.',
  };
}

async function checkStudioAssets(root: string): Promise<StudioAgentSetupCheck> {
  const index = await stat(join(root, 'index.html')).catch(() => undefined);
  const assets = await readdir(join(root, 'assets')).catch(() => []);
  if (!index?.isFile() || !assets.some((name) => name.endsWith('.js'))) {
    return {
      name: 'studio-assets',
      status: 'fail',
      message: 'Bundled Studio assets are missing or incomplete.',
      recovery: 'Rerun with --ensure-engine to rebuild the Studio assets.',
    };
  }
  return { name: 'studio-assets', status: 'pass', message: 'Bundled Studio assets are present.' };
}

async function checkWorkspace(
  workspace: string,
  contained: boolean,
): Promise<StudioAgentSetupCheck> {
  if (!contained) {
    return {
      name: 'workspace',
      status: 'fail',
      message: 'Workspace containment failed.',
      recovery: 'Choose a dedicated workspace inside SMART_UI_MCP_ROOT.',
    };
  }
  const parent = await nearestExistingParent(resolve(workspace));
  try {
    await access(parent, 2);
    return { name: 'workspace', status: 'pass', message: 'The Studio workspace path is writable.' };
  } catch {
    return {
      name: 'workspace',
      status: 'fail',
      message: 'The Studio workspace path is not writable.',
      recovery: 'Choose a writable dedicated workspace inside SMART_UI_MCP_ROOT.',
    };
  }
}

async function checkHostConfig(options: StudioAgentSetupOptions): Promise<StudioAgentSetupCheck> {
  try {
    const current = await readFile(options.hostConfigPath, 'utf8');
    if (current !== options.expectedHostConfig) {
      return {
        name: 'host-config',
        status: 'fail',
        message: `The existing ${options.host} host configuration differs from the required configuration.`,
        recovery: `Review and merge the generated Smart UI block into the existing host config; do not overwrite ${options.hostConfigPath}.`,
      };
    }
    return {
      name: 'host-config',
      status: 'pass',
      message: `${options.host} host configuration matches.`,
    };
  } catch (error) {
    if (!missing(error)) throw error;
    return {
      name: 'host-config',
      status: 'fail',
      message: `${options.host} host configuration is absent.`,
      recovery: `Run smart-ui studio --agent --host ${options.host} --workspace ${JSON.stringify(options.workspaceRoot)}, then follow its restart action.`,
    };
  }
}

async function checkLoopback(): Promise<StudioAgentSetupCheck> {
  const server = createServer((_request, response) => response.end('ok'));
  try {
    await new Promise<void>((accept, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => accept());
    });
    return { name: 'loopback', status: 'pass', message: 'An ephemeral 127.0.0.1 listener opened.' };
  } catch {
    return {
      name: 'loopback',
      status: 'fail',
      message: 'An isolated loopback listener could not open.',
      recovery: 'Allow local 127.0.0.1 listeners for Smart UI Studio and retry.',
    };
  } finally {
    if (server.listening) await new Promise<void>((accept) => server.close(() => accept()));
  }
}

async function nearestExistingParent(path: string): Promise<string> {
  let current = path;
  for (;;) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (!missing(error)) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function newestModifiedTime(path: string): Promise<number> {
  const details = await stat(path).catch(() => undefined);
  if (!details) return 0;
  if (!details.isDirectory()) return details.mtimeMs;
  const entries = await readdir(path, { withFileTypes: true });
  return Math.max(
    details.mtimeMs,
    ...(await Promise.all(entries.map((entry) => newestModifiedTime(join(path, entry.name))))),
  );
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
