import { describe, expect, it, vi } from 'vitest';
import {
  runSetup as publicRunSetup,
  type DoctorCheck,
  type SetupOptions,
  type SetupResult,
} from '../packages/core/src/index.js';

const runSetup = publicRunSetup as unknown as (
  targetRoot: string,
  options: SetupOptions,
  dependencies: Record<string, unknown>,
) => Promise<SetupResult>;

const readyDiagnosis = {
  schemaVersion: '1.0' as const,
  ready: true,
  checks: [] as DoctorCheck[],
};

describe('supported setup workflow', () => {
  it('skips installation when Chromium already launches', async () => {
    const installBrowser = vi.fn();
    const result = await runSetup(
      '/target',
      {},
      {
        probeBrowser: vi.fn().mockResolvedValue(undefined),
        installBrowser,
        doctor: vi.fn().mockResolvedValue(readyDiagnosis),
      },
    );

    expect(installBrowser).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ready: true,
      actions: [
        { name: 'chromium-install', status: 'skipped' },
        { name: 'agent-memory', status: 'skipped' },
      ],
    });
  });

  it('installs Chromium and runs the optional Agent Memory canary', async () => {
    const result = await runSetup(
      '/target',
      { verifyAgentMemory: true },
      {
        probeBrowser: vi.fn().mockRejectedValue(new Error('missing')),
        installBrowser: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
        probeMemory: vi.fn().mockResolvedValue({
          name: 'agent-memory',
          status: 'pass',
          message: 'persistence ready',
        }),
        doctor: vi.fn().mockResolvedValue(readyDiagnosis),
      },
    );

    expect(result).toMatchObject({
      ready: true,
      actions: [
        { name: 'chromium-install', status: 'completed' },
        { name: 'agent-memory', status: 'completed' },
      ],
    });
  });

  it('returns an unready result when installation fails', async () => {
    const result = await runSetup(
      '/target',
      {},
      {
        probeBrowser: vi.fn().mockRejectedValue(new Error('missing')),
        installBrowser: vi
          .fn()
          .mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'download failed' }),
        doctor: vi.fn().mockResolvedValue({ ...readyDiagnosis, ready: false }),
      },
    );

    expect(result.ready).toBe(false);
    expect(result.actions[0]).toMatchObject({
      name: 'chromium-install',
      status: 'failed',
      message: 'download failed',
    });
  });

  it('turns installer process errors into a structured readiness failure', async () => {
    const result = await runSetup(
      '/target',
      {},
      {
        probeBrowser: vi.fn().mockRejectedValue(new Error('missing')),
        installBrowser: vi.fn().mockRejectedValue(new Error('installer unavailable')),
        doctor: vi.fn().mockResolvedValue({ ...readyDiagnosis, ready: false }),
      },
    );

    expect(result.ready).toBe(false);
    expect(result.actions[0]).toMatchObject({
      name: 'chromium-install',
      status: 'failed',
      message: 'installer unavailable',
    });
  });
});
