import { lstat, mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { GenerationExporter } from './generation-providers.js';
import { validateGeneratedPath } from './generated-output.js';
import { SmartUiError } from './errors.js';

interface ExportFile {
  relativePath: string;
  bytes: Uint8Array;
}

export class ReproducibleGenerationExporter implements GenerationExporter {
  constructor(private readonly workspaceRoot: string) {}

  async archive(files: readonly ExportFile[], signal?: AbortSignal): Promise<Uint8Array> {
    abort(signal, 'Generation archive');
    const sorted = [...files].sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    );
    sorted.forEach((file) => validateGeneratedPath(file.relativePath));
    const localParts: Uint8Array[] = [];
    const centralParts: Uint8Array[] = [];
    let offset = 0;
    for (const file of sorted) {
      abort(signal, 'Generation archive');
      const name = new TextEncoder().encode(file.relativePath);
      const crc = crc32(file.bytes);
      const local = concat(
        u32(0x04034b50),
        u16(20),
        u16(0x0800),
        u16(0),
        u16(0),
        u16(0x0021),
        u32(crc),
        u32(file.bytes.byteLength),
        u32(file.bytes.byteLength),
        u16(name.byteLength),
        u16(0),
        name,
        file.bytes,
      );
      localParts.push(local);
      centralParts.push(
        concat(
          u32(0x02014b50),
          u16(0x0314),
          u16(20),
          u16(0x0800),
          u16(0),
          u16(0),
          u16(0x0021),
          u32(crc),
          u32(file.bytes.byteLength),
          u32(file.bytes.byteLength),
          u16(name.byteLength),
          u16(0),
          u16(0),
          u16(0),
          u16(0),
          u32(0o100644 << 16),
          u32(offset),
          name,
        ),
      );
      offset += local.byteLength;
    }
    const central = concat(...centralParts);
    return concat(
      ...localParts,
      central,
      u32(0x06054b50),
      u16(0),
      u16(0),
      u16(sorted.length),
      u16(sorted.length),
      u32(central.byteLength),
      u32(offset),
      u16(0),
    );
  }

  async materialize(
    exportRoot: string,
    files: readonly ExportFile[],
    signal?: AbortSignal,
  ): Promise<string[]> {
    abort(signal, 'Generation export');
    const declaredWorkspace = resolve(this.workspaceRoot);
    const workspace = await realpath(declaredWorkspace);
    const declaredTarget = resolve(exportRoot);
    const rel = relative(declaredWorkspace, declaredTarget);
    if (rel.startsWith('..') || isAbsolute(rel) || declaredTarget === declaredWorkspace) {
      throw new SmartUiError(
        'POLICY_VIOLATION',
        'Export directory escapes the declared workspace.',
      );
    }
    const target = resolve(workspace, rel);
    await assertExistingParentsContained(workspace, target);
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new SmartUiError('POLICY_VIOLATION', 'Export path must be a new empty directory.');
      }
      if ((await readdir(target)).length > 0) {
        throw new SmartUiError('POLICY_VIOLATION', 'Export directory must be empty.');
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      await mkdir(target);
    }
    const written: string[] = [];
    for (const file of [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
      abort(signal, 'Generation export');
      validateGeneratedPath(file.relativePath);
      const destination = resolve(target, file.relativePath);
      const destinationRel = relative(target, destination);
      if (destinationRel.startsWith('..') || isAbsolute(destinationRel)) {
        throw new SmartUiError(
          'POLICY_VIOLATION',
          `Export file escapes output: ${file.relativePath}`,
        );
      }
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, file.bytes, { flag: 'wx', mode: 0o644 });
      written.push(resolve(declaredTarget, file.relativePath));
    }
    return written;
  }
}

function abort(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted) throw new SmartUiError('PROVIDER_FAILURE', `${operation} was canceled.`);
}

async function assertExistingParentsContained(workspace: string, target: string): Promise<void> {
  let current = target;
  const pending: string[] = [];
  while (current !== workspace) {
    pending.push(current);
    const parent = dirname(current);
    if (parent === current) throw new SmartUiError('POLICY_VIOLATION', 'Invalid export root.');
    current = parent;
  }
  for (const path of pending.reverse()) {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink())
        throw new SmartUiError('POLICY_VIOLATION', 'Export path crosses a symbolic link.');
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function u16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  return bytes;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
