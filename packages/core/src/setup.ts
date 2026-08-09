import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AgentMemoryProvider } from './agent-memory-provider.js';
import { loadConfig } from './config.js';
import { probeChromium, runDoctor, type DoctorCheck } from './doctor.js';
import { LocalMemoryProvider } from './memory.js';
import { redactSensitiveText } from './security.js';

export interface SetupAction {
  name: 'chromium-install' | 'agent-memory';
  status: 'completed' | 'skipped' | 'failed';
  message: string;
}

export interface SetupResult {
  schemaVersion: '1.0';
  ready: boolean;
  actions: SetupAction[];
  diagnosis: Awaited<ReturnType<typeof runDoctor>>;
}

export interface SetupOptions {
  verifyAgentMemory?: boolean;
  onBrowserInstallOutput?: (text: string) => void;
}

interface SetupDependencies {
  probeBrowser: () => Promise<void>;
  installBrowser: (onOutput?: (text: string) => void) => Promise<ProcessResult>;
  probeMemory: () => Promise<DoctorCheck>;
  doctor: typeof runDoctor;
}

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Installs optional local runtime assets and then performs evidence-backed readiness checks. */
export function runSetup(targetRoot: string, options?: SetupOptions): Promise<SetupResult>;
export async function runSetup(
  targetRoot: string,
  options: SetupOptions = {},
  dependencies: Partial<SetupDependencies> = {},
): Promise<SetupResult> {
  const actions: SetupAction[] = [];
  const probeBrowser = dependencies.probeBrowser ?? probeChromium;
  const installBrowser =
    dependencies.installBrowser ??
    ((onOutput) => installPlaywrightChromium(targetRoot, { ...(onOutput ? { onOutput } : {}) }));

  try {
    await probeBrowser();
    actions.push({
      name: 'chromium-install',
      status: 'skipped',
      message: 'The pinned Playwright Chromium already launches successfully.',
    });
  } catch {
    try {
      const result = await installBrowser(options.onBrowserInstallOutput);
      if (result.exitCode === 0) {
        actions.push({
          name: 'chromium-install',
          status: 'completed',
          message: 'Installed the Chromium revision pinned by Smart UI Validator.',
        });
      } else {
        actions.push({
          name: 'chromium-install',
          status: 'failed',
          message: redactSensitiveText(
            result.stderr || result.stdout || `Playwright installer exited ${result.exitCode}.`,
            4_000,
          ),
        });
      }
    } catch (error) {
      actions.push({
        name: 'chromium-install',
        status: 'failed',
        message: redactSensitiveText(error instanceof Error ? error.message : String(error), 4_000),
      });
    }
  }

  let configuredAgentMemory = false;
  try {
    const config = await loadConfig(targetRoot);
    configuredAgentMemory = config.memory.enabled && config.memory.backend === 'agent-memory';
  } catch {
    // Doctor reports the invalid configuration; setup must not infer memory settings from it.
  }
  if (options.verifyAgentMemory || configuredAgentMemory) {
    const check = await (dependencies.probeMemory ?? probeAgentMemory)();
    actions.push({
      name: 'agent-memory',
      status: check.status === 'pass' ? 'completed' : 'failed',
      message: check.message,
    });
  } else {
    actions.push({
      name: 'agent-memory',
      status: 'skipped',
      message:
        'Agent Memory is optional and not enabled for this project; use --agent-memory to run its SQLite persistence canary.',
    });
  }

  const diagnosis = await (dependencies.doctor ?? runDoctor)(targetRoot);
  return {
    schemaVersion: '1.0',
    ready: diagnosis.ready && !actions.some((action) => action.status === 'failed'),
    actions,
    diagnosis,
  };
}

/** Runs Playwright's package-local installer without invoking a shell or global package manager. */
async function installPlaywrightChromium(
  cwd: string,
  options: { onOutput?: (text: string) => void; timeoutMs?: number } = {},
): Promise<ProcessResult> {
  const require = createRequire(import.meta.url);
  const playwrightRoot = dirname(require.resolve('playwright/package.json'));
  const cliPath = join(playwrightRoot, 'cli.js');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, 'install', 'chromium'], {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const maxOutputCharacters = 1_000_000;
    const capture = (stream: 'stdout' | 'stderr', text: string): void => {
      options.onOutput?.(text);
      if (stream === 'stdout' && stdout.length < maxOutputCharacters)
        stdout += text.slice(0, maxOutputCharacters - stdout.length);
      if (stream === 'stderr' && stderr.length < maxOutputCharacters)
        stderr += text.slice(0, maxOutputCharacters - stderr.length);
    };
    child.stdout.setEncoding('utf8').on('data', (text: string) => capture('stdout', text));
    child.stderr.setEncoding('utf8').on('data', (text: string) => capture('stderr', text));
    const timer = setTimeout(
      () => {
        child.kill('SIGTERM');
        reject(new Error('Playwright Chromium installation exceeded the setup timeout.'));
      },
      options.timeoutMs ?? 15 * 60_000,
    );
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

/** Proves the embedded SQLite adapter can write, close, reopen, read, and delete a record. */
async function probeAgentMemory(): Promise<DoctorCheck> {
  const directory = await mkdtemp(join(tmpdir(), 'smart-ui-setup-memory-'));
  const databasePath = join(directory, 'canary.sqlite');
  const identity = { tenantId: 'smart-ui-setup', userId: 'canary' };
  let first: AgentMemoryProvider | undefined;
  let second: AgentMemoryProvider | undefined;
  try {
    first = new AgentMemoryProvider(
      new LocalMemoryProvider(join(directory, 'governance-1.json'), undefined, false, identity),
      { databasePath, identity },
    );
    const status = await first.integrationStatus();
    if (!status.liveIntegrationVerified)
      throw new Error(status.limitation ?? 'Agent Memory initialized in degraded mode.');
    const candidate = await first.propose({
      type: 'preference',
      layer: 'L1',
      value: 'smart-ui-setup-canary=true',
      scope: { kind: 'repository', id: 'smart-ui-setup-canary' },
      selectors: { repositoryId: 'smart-ui-setup-canary' },
      identity,
      confidence: 1,
      promotionReason: 'Disposable Smart UI setup persistence canary.',
      evidence: [{ kind: 'interaction', summary: 'Explicit setup health check.' }],
      creator: 'smart-ui-setup',
      sensitivity: 'internal',
      retention: { policy: 'session' },
      consent: {
        granted: false,
        recordedAt: new Date().toISOString(),
        actor: 'smart-ui-setup',
      },
    });
    await first.confirm(candidate.id);
    await first.close();
    first = undefined;

    second = new AgentMemoryProvider(
      new LocalMemoryProvider(join(directory, 'governance-2.json'), undefined, false, identity),
      { databasePath, identity },
    );
    const persisted = await second.show(candidate.id);
    if (persisted?.state !== 'confirmed') throw new Error('Canary record did not survive reopen.');
    if (!(await second.forget(candidate.id)))
      throw new Error('Canary record could not be deleted.');
    return {
      name: 'agent-memory',
      status: 'pass',
      message:
        'Embedded SQLite and Agent Memory passed write, close, reopen, read, and delete checks.',
    };
  } catch (error) {
    return {
      name: 'agent-memory',
      status: 'fail',
      message: `Agent Memory persistence canary failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await first?.close().catch(() => undefined);
    await second?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}
