import { spawn } from 'node:child_process';
import type { PolicyProvider } from './providers.js';
import { SmartUiError } from './errors.js';

/** Runs only policy-approved executables with explicit args, cwd, timeout and captured output. */
export async function runAllowedProcess(
  policy: PolicyProvider,
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  policy.assertCommand(command, args);
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const maxOutputCharacters = 1_000_000;
    child.stdout.setEncoding('utf8').on('data', (data: string) => {
      if (stdout.length < maxOutputCharacters)
        stdout += data.slice(0, maxOutputCharacters - stdout.length);
    });
    child.stderr.setEncoding('utf8').on('data', (data: string) => {
      if (stderr.length < maxOutputCharacters)
        stderr += data.slice(0, maxOutputCharacters - stderr.length);
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new SmartUiError('TIMEOUT', `${command} exceeded ${policy.maxExecutionTimeMs}ms`));
    }, policy.maxExecutionTimeMs);
    const cleanup = () => clearTimeout(timer);
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('close', (code) => {
      cleanup();
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}
