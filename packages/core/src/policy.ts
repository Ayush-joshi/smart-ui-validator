import { isAbsolute, relative, resolve } from 'node:path';
import { SmartUiError } from './errors.js';
import type { PolicyProvider } from './providers.js';

export interface LocalPolicyOptions {
  targetRoot: string;
  writableFiles?: readonly string[];
  allowedCommands?: Readonly<Record<string, readonly string[]>>;
  dryRun?: boolean;
  maxExecutionTimeMs?: number;
}

export class LocalPolicy implements PolicyProvider {
  readonly targetRoot: string;
  readonly dryRun: boolean;
  readonly maxExecutionTimeMs: number;
  private readonly writable: Set<string>;
  private readonly commands: Readonly<Record<string, readonly string[]>>;

  constructor(options: LocalPolicyOptions) {
    this.targetRoot = resolve(options.targetRoot);
    this.dryRun = options.dryRun ?? false;
    this.maxExecutionTimeMs = options.maxExecutionTimeMs ?? 60_000;
    this.writable = new Set(
      (options.writableFiles ?? []).map((path) => this.resolveContained(path)),
    );
    this.commands = options.allowedCommands ?? {};
  }

  assertReadable(path: string): void {
    this.resolveContained(path);
  }

  assertWritable(path: string): void {
    const resolved = this.resolveContained(path);
    if (!this.writable.has(resolved)) {
      throw new SmartUiError('POLICY_VIOLATION', `Write is not allowlisted: ${path}`);
    }
  }

  assertCommand(command: string, args: readonly string[]): void {
    const allowedPrefixes = this.commands[command];
    if (!allowedPrefixes || !args.every((arg) => !arg.includes('\0'))) {
      throw new SmartUiError('POLICY_VIOLATION', `Command is not allowlisted: ${command}`);
    }
    const serialized = args.join(' ');
    if (!allowedPrefixes.some((prefix) => serialized.startsWith(prefix))) {
      throw new SmartUiError('POLICY_VIOLATION', `Arguments are not allowlisted for: ${command}`);
    }
  }

  private resolveContained(path: string): string {
    const resolved = resolve(this.targetRoot, path);
    const rel = relative(this.targetRoot, resolved);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new SmartUiError('POLICY_VIOLATION', `Path escapes target root: ${path}`);
    }
    return resolved;
  }
}
