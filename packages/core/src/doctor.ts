import { access } from 'node:fs/promises';
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
    await access(chromium.executablePath());
    checks.push({
      name: 'chromium',
      status: 'pass',
      message: 'Isolated Playwright Chromium is installed.',
    });
  } catch {
    checks.push({
      name: 'chromium',
      status: 'fail',
      message: 'Chromium is missing; run pnpm exec playwright install chromium.',
    });
  }
  return {
    schemaVersion: '1.0',
    ready: !checks.some((check) => check.status === 'fail'),
    checks: redactSensitiveValue(checks) as DoctorCheck[],
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
