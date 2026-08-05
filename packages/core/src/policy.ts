import { isAbsolute, relative, resolve } from 'node:path';
import { SmartUiError } from './errors.js';
import type { PolicyProvider } from './providers.js';
import type { CommandSpec } from './config.js';
import { isUrlAllowed } from './security.js';

export interface LocalPolicyOptions {
  targetRoot: string;
  writableFiles?: readonly string[];
  allowedCommands?: readonly CommandSpec[];
  allowedEndpoints?: readonly string[];
  dryRun?: boolean;
  maxExecutionTimeMs?: number;
}

export class LocalPolicy implements PolicyProvider {
  readonly targetRoot: string;
  readonly dryRun: boolean;
  readonly maxExecutionTimeMs: number;
  readonly writableFiles: readonly string[];
  private readonly writable: Set<string>;
  private readonly commands: readonly CommandSpec[];
  private readonly endpoints: readonly string[];

  constructor(options: LocalPolicyOptions) {
    this.targetRoot = resolve(options.targetRoot);
    this.dryRun = options.dryRun ?? false;
    this.maxExecutionTimeMs = options.maxExecutionTimeMs ?? 60_000;
    this.writableFiles = [...(options.writableFiles ?? [])];
    this.writable = new Set(this.writableFiles.map((path) => this.resolveContained(path)));
    this.commands = options.allowedCommands ?? [];
    this.endpoints = options.allowedEndpoints ?? [];
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
    if (command.includes('\0') || args.some((argument) => argument.includes('\0'))) {
      throw new SmartUiError('POLICY_VIOLATION', 'Command contains a null byte.');
    }
    const allowed = this.commands.some(
      (candidate) =>
        candidate.executable === command &&
        candidate.args.length === args.length &&
        candidate.args.every((argument, index) => argument === args[index]),
    );
    if (!allowed) {
      throw new SmartUiError(
        'POLICY_VIOLATION',
        `Command is not exactly allowlisted: ${command} ${args.join(' ')}`,
      );
    }
  }

  assertEndpoint(url: string): void {
    if (!isUrlAllowed(url, this.endpoints)) {
      throw new SmartUiError('POLICY_VIOLATION', `Endpoint is not allowlisted: ${url}`);
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
