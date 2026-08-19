import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadHandoffTask,
  prepareImplementationTask,
  reviewImplementationTask,
  submitHandoffImplementation,
} from '../packages/core/src/index.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function repository(name: string, framework: 'react' | 'angular') {
  const root = await mkdtemp(join(resolve('tests'), `.implementation-${name}-`));
  temporaryPaths.push(root);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      scripts: { build: framework === 'react' ? 'vite build' : 'ng build' },
      dependencies: framework === 'react' ? { react: '19.1.1' } : { '@angular/core': '18.0.0' },
      devDependencies: framework === 'react' ? { vite: '8.2.0' } : { '@angular/cli': '18.0.0' },
    }),
  );
  const sourcePath = framework === 'react' ? 'src/Dashboard.tsx' : 'src/dashboard.component.ts';
  await writeFile(
    join(root, ...sourcePath.split('/')),
    framework === 'react'
      ? 'export function Dashboard() { return <main>Current</main>; }\n'
      : "import { Component } from '@angular/core';\n@Component({ selector: 'app-dashboard', template: '<main>Current</main>' })\nexport class DashboardComponent {}\n",
  );
  return { root, sourcePath };
}

describe('validate-UI task preparation', () => {
  it('pins sanitized SVG evidence, React inspection, exact baselines, and score classes', async () => {
    const { root, sourcePath } = await repository('react', 'react');
    const designPath = join(root, 'design.svg');
    await writeFile(
      designPath,
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><script>alert(1)</script><text x="8" y="24">Dashboard</text></svg>',
    );
    await expect(
      prepareImplementationTask({
        target: root,
        designPath,
        route: 'http://127.0.0.1:4173/dashboard',
        writableFiles: [sourcePath],
      }),
    ).rejects.toThrow(/active content|script/u);

    await writeFile(
      designPath,
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><text x="8" y="24">Dashboard</text></svg>',
    );
    await writeFile(
      join(root, 'mobile.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="240"><text x="8" y="24">Mobile</text></svg>',
    );
    const presentationPath = join(root, 'presentation.json');
    await writeFile(
      presentationPath,
      JSON.stringify({
        schemaVersion: '1.0',
        primaryCanvas: { id: 'desktop', width: 320, height: 180, deviceScaleFactor: 1 },
        fit: 'intrinsic',
        horizontalAlignment: 'start',
        verticalAlignment: 'start',
        viewports: [
          {
            id: 'mobile',
            width: 160,
            height: 240,
            deviceScaleFactor: 1,
            requirement: 'required',
            reference: { path: 'mobile.svg', mediaType: 'image/svg+xml' },
          },
        ],
      }),
    );
    const prepared = await prepareImplementationTask({
      target: root,
      designPath,
      presentationPath,
      route: 'http://127.0.0.1:4173/dashboard',
      writableFiles: [sourcePath, 'src/Dashboard.css'],
    });
    expect(prepared.task.framework.framework).toBe('react');
    expect(prepared.task.baselines).toEqual([
      expect.objectContaining({
        relativePath: sourcePath,
        existed: true,
        hash: expect.stringMatching(/^sha256:/),
      }),
      { relativePath: 'src/Dashboard.css', existed: false },
    ]);
    expect(prepared.task.matrix.map((cell) => cell.classification)).toEqual([
      'source-fidelity',
      'alternate-reference-fidelity',
    ]);
    expect(prepared.task.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'viewport-reference', provenance: 'presentation:mobile' }),
      ]),
    );
    const evidence = prepared.task.evidence[0]!;
    expect(await readFile(join(prepared.taskRoot, evidence.relativePath), 'utf8')).not.toContain(
      '<script',
    );
    expect((await loadHandoffTask(prepared.taskFile)).task.taskHash).toBe(prepared.task.taskHash);
  });

  it('normalizes PNG for an Angular task and rejects traversing writable paths', async () => {
    const { root, sourcePath } = await repository('angular', 'angular');
    const designPath = join(root, 'design.png');
    await writeFile(
      designPath,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3k0AAAAASUVORK5CYII=',
        'base64',
      ),
    );
    const prepared = await prepareImplementationTask({
      target: root,
      designPath,
      route: 'http://127.0.0.1:4200/dashboard',
      writableFiles: [sourcePath],
    });
    expect(prepared.task.framework.framework).toBe('angular');
    expect(prepared.task.design.mediaType).toBe('image/png');
    expect(
      await readFile(join(prepared.taskRoot, prepared.task.designContractPath), 'utf8'),
    ).toContain('data:image/png;base64');
    await expect(
      prepareImplementationTask({
        target: root,
        designPath,
        route: 'http://127.0.0.1:4200/dashboard',
        writableFiles: ['../escape.ts'],
        dryRun: true,
      }),
    ).rejects.toThrow();
  });

  it('reviews an ordered live-route matrix without scoring robustness-only cells', async () => {
    const { root, sourcePath } = await repository('review', 'react');
    const designPath = join(root, 'design.svg');
    await writeFile(
      designPath,
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="white"/><text x="16" y="36" font-size="24">Dashboard</text></svg>',
    );
    const presentationPath = join(root, 'presentation.json');
    await writeFile(
      presentationPath,
      JSON.stringify({
        schemaVersion: '1.0',
        primaryCanvas: { id: 'desktop', width: 320, height: 180, deviceScaleFactor: 1 },
        fit: 'intrinsic',
        horizontalAlignment: 'start',
        verticalAlignment: 'start',
        viewports: [
          { id: 'mobile', width: 180, height: 240, deviceScaleFactor: 1, requirement: 'required' },
        ],
      }),
    );
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(
        '<!doctype html><html><body><main style="font:24px sans-serif">Dashboard</main></body></html>',
      );
    });
    await new Promise<void>((resolveListening) => server.listen(0, '127.0.0.1', resolveListening));
    try {
      const port = (server.address() as AddressInfo).port;
      const prepared = await prepareImplementationTask({
        target: root,
        designPath,
        presentationPath,
        route: `http://127.0.0.1:${port}/dashboard`,
        writableFiles: [sourcePath],
      });
      const authored = 'export function Dashboard() { return <main>Dashboard</main>; }\n';
      await writeFile(join(root, ...sourcePath.split('/')), authored);
      const reviewed = await reviewImplementationTask({ taskFile: prepared.taskFile });
      expect(reviewed.index.cells.map((cell) => cell.classification)).toEqual([
        'source-fidelity',
        'responsive-robustness',
      ]);
      expect(reviewed.index.cells[0]?.score).not.toBeNull();
      expect(reviewed.index.cells[1]).toMatchObject({
        score: null,
        visualMismatchPercent: null,
      });
      expect(reviewed.result.implementation?.changedFiles).toEqual([sourcePath]);
      expect(
        await readFile(join(reviewed.attemptRoot, 'before', ...sourcePath.split('/')), 'utf8'),
      ).toContain('Current');
      expect(
        await readFile(join(reviewed.attemptRoot, 'submitted', ...sourcePath.split('/')), 'utf8'),
      ).toBe(authored);
      expect(await readFile(join(root, ...sourcePath.split('/')), 'utf8')).toBe(authored);

      const mcpAuthored =
        'export function Dashboard() { return <main>Dashboard revised</main>; }\n';
      await expect(
        submitHandoffImplementation({
          taskFile: prepared.taskFile,
          taskHash: prepared.task.taskHash,
          revision: 0,
          authoringAgent: 'mcp-test',
          files: [{ relativePath: sourcePath, content: mcpAuthored }],
        }),
      ).rejects.toThrow(new RegExp(`revision ${reviewed.state.revision}`, 'u'));
      expect(await readFile(join(root, ...sourcePath.split('/')), 'utf8')).toBe(authored);

      const submitted = await submitHandoffImplementation({
        taskFile: prepared.taskFile,
        taskHash: prepared.task.taskHash,
        revision: reviewed.state.revision,
        authoringAgent: 'mcp-test',
        files: [{ relativePath: sourcePath, content: mcpAuthored }],
      });
      expect(submitted.attempt).toBe(2);
      expect(submitted.state.attempts[1]).toMatchObject({ source: 'mcp', author: 'mcp-test' });
      expect(await readFile(join(root, ...sourcePath.split('/')), 'utf8')).toBe(mcpAuthored);
    } finally {
      await new Promise<void>((resolveClosed, reject) =>
        server.close((error) => (error ? reject(error) : resolveClosed())),
      );
    }
  }, 60_000);
});
