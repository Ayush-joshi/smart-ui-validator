import { chromium } from 'playwright';
import { AutoFrameworkAdapter } from './auto-framework-adapter.js';
import { loadConfig } from './config.js';
import { redactSensitiveValue } from './security.js';

export interface DoctorCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
}

/** Read-only, redacted local readiness diagnostics for operators and support bundles. */
export async function runDoctor(targetRoot: string): Promise<{
  schemaVersion: '1.0';
  ready: boolean;
  checks: DoctorCheck[];
}> {
  const checks: DoctorCheck[] = [];
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  checks.push({
    name: 'node',
    status: major > 22 || (major === 22 && minor >= 16) ? 'pass' : 'fail',
    message: `Node ${process.versions.node}; required >=22.16.`,
  });
  try {
    const inspection = await new AutoFrameworkAdapter().inspect(targetRoot);
    checks.push({
      name: 'framework',
      status: inspection.framework === 'unknown' ? 'fail' : 'pass',
      message: `${inspection.framework}; build=${inspection.buildSystem ?? 'unknown'}; packageManager=${inspection.packageManager ?? 'unknown'}.`,
    });
    if ((inspection.ambiguities ?? []).length > 0) {
      checks.push({
        name: 'discovery',
        status: 'warn',
        message: (inspection.ambiguities ?? []).join(' '),
      });
    }
  } catch (error) {
    checks.push({ name: 'framework', status: 'fail', message: messageOf(error) });
  }
  try {
    const config = await loadConfig(targetRoot);
    checks.push({
      name: 'config',
      status: 'pass',
      message: `Configuration valid; telemetry=${config.memory.telemetryEnabled ? 'opt-in' : 'off'}; externalNetwork=${config.policy.blockExternalNetwork ? 'blocked' : 'allowed by policy'}.`,
    });
  } catch (error) {
    checks.push({ name: 'config', status: 'fail', message: messageOf(error) });
  }
  try {
    await probeChromium();
    checks.push({
      name: 'chromium',
      status: 'pass',
      message: 'Isolated Playwright Chromium launched successfully.',
    });
  } catch (error) {
    checks.push({
      name: 'chromium',
      status: 'fail',
      message: `Chromium launch failed: ${messageOf(error)} Run "smart-ui setup --target <project>" to install and verify it.`,
    });
  }
  return {
    schemaVersion: '1.0',
    ready: !checks.some((check) => check.status === 'fail'),
    checks: redactSensitiveValue(checks) as DoctorCheck[],
  };
}

/** Launches an isolated browser canary so readiness proves more than file presence. */
export async function probeChromium(): Promise<void> {
  const browser = await chromium.launch({ headless: true, timeout: 30_000 });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><title>Smart UI browser canary</title>');
    const title = await page.title();
    if (title !== 'Smart UI browser canary')
      throw new Error('Browser canary returned bad content.');
  } finally {
    await browser.close();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
