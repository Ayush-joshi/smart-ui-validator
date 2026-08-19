import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  allocateHandoffAttempt,
  loadHandoffTask,
  prepareGenerationTask,
  resolveTaskPath,
  withHandoffTaskLock,
} from '../packages/core/src/index.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function task(name: string) {
  const workspace = await mkdtemp(join(resolve('tests'), `.handoff-store-${name}-`));
  temporaryPaths.push(workspace);
  const designPath = join(workspace, 'design.svg');
  await writeFile(designPath, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
  return prepareGenerationTask({ workspace, designPath, mode: 'hybrid', layout: 'responsive' });
}

describe('handoff store security and recovery', () => {
  it('rejects contract tampering and competing task mutations', async () => {
    const prepared = await task('tamper');
    const original = await readFile(prepared.taskFile, 'utf8');
    await writeFile(prepared.taskFile, original.replace('"hybrid"', '"semantic"'));
    await expect(loadHandoffTask(prepared.taskFile)).rejects.toThrow(/hash check/u);
    await writeFile(prepared.taskFile, original);

    let release!: () => void;
    const held = new Promise<void>((resolveHeld) => {
      release = resolveHeld;
    });
    const owner = withHandoffTaskLock(prepared.taskRoot, async () => held);
    await new Promise<void>((resolveReady) => setImmediate(resolveReady));
    await expect(withHandoffTaskLock(prepared.taskRoot, async () => undefined)).rejects.toThrow(
      /Another Smart UI process/u,
    );
    release();
    await owner;
  });

  it('recovers a verified stale lock and quarantines an incomplete attempt', async () => {
    const prepared = await task('recover');
    await writeFile(
      join(prepared.taskRoot, '.task-lock'),
      `${JSON.stringify({ owner: 'crashed', acquiredAt: '2000-01-01T00:00:00.000Z' })}\n`,
    );
    await expect(withHandoffTaskLock(prepared.taskRoot, async () => 'recovered')).resolves.toBe(
      'recovered',
    );

    await mkdir(join(prepared.taskRoot, 'reviews', 'attempt-0001'), { recursive: true });
    const allocated = await allocateHandoffAttempt(prepared.taskRoot, prepared.state);
    expect(allocated.attempt).toBe(2);
    expect(await readdir(join(prepared.taskRoot, 'reviews'))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^attempt-0001\.quarantined-/u),
        'attempt-0002',
      ]),
    );
  });

  it('rejects task paths that cross a symbolic link', async () => {
    const prepared = await task('symlink');
    const outside = await mkdtemp(join(resolve('tests'), '.handoff-outside-'));
    temporaryPaths.push(outside);
    await writeFile(join(outside, 'file.svg'), '<svg/>');
    const link = join(prepared.taskRoot, 'proposal', 'linked');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(
      resolveTaskPath(prepared.taskRoot, 'proposal/linked/file.svg', 'Proposal asset'),
    ).rejects.toThrow(/symbolic link/u);
  });
});
