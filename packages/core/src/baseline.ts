import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { SmartUiError } from './errors.js';
import { artifactRefSchema, type ArtifactRef } from './schemas.js';

export const baselineEntrySchema = z
  .object({
    key: z.string().min(1),
    tenantId: z.string().min(1),
    repositoryId: z.string().min(1),
    component: z.string().min(1),
    viewport: z.string().min(1),
    state: z.string().min(1),
    artifact: artifactRefSchema,
    approvedAt: z.string().datetime(),
    approvedBy: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

export const baselineManifestSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    entries: z.record(z.string(), baselineEntrySchema),
  })
  .strict();

export interface BaselineIdentity {
  tenantId: string;
  repositoryId: string;
  component: string;
  viewport: string;
  state: string;
}

/** Versioned baseline manifest. Updates always require a named human approval and reason. */
export class LocalBaselineStore {
  private readonly manifestPath: string;

  constructor(manifestPath: string) {
    this.manifestPath = resolve(manifestPath);
  }

  async review(
    identity: BaselineIdentity,
    candidate: ArtifactRef,
  ): Promise<{
    status: 'missing' | 'matched' | 'changed';
    baseline?: ArtifactRef;
    candidate: ArtifactRef;
  }> {
    const entry = (await this.read()).entries[keyFor(identity)];
    if (!entry) return { status: 'missing', candidate };
    return {
      status: entry.artifact.hash === candidate.hash ? 'matched' : 'changed',
      baseline: entry.artifact,
      candidate,
    };
  }

  async approve(
    identity: BaselineIdentity,
    artifact: ArtifactRef,
    approval: { approved: boolean; actor: string; reason: string },
  ) {
    if (!approval.approved || !approval.actor.trim() || !approval.reason.trim()) {
      throw new SmartUiError(
        'POLICY_VIOLATION',
        'Baseline changes require explicit approval, a named actor, and a review reason.',
      );
    }
    const manifest = await this.read();
    const key = keyFor(identity);
    const entry = baselineEntrySchema.parse({
      key,
      ...identity,
      artifact,
      approvedAt: new Date().toISOString(),
      approvedBy: approval.actor,
      reason: approval.reason,
    });
    manifest.entries[key] = entry;
    await this.write(manifest);
    return entry;
  }

  async read() {
    try {
      return baselineManifestSchema.parse(JSON.parse(await readFile(this.manifestPath, 'utf8')));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return baselineManifestSchema.parse({ schemaVersion: '1.0', entries: {} });
      }
      throw error;
    }
  }

  private async write(manifest: z.infer<typeof baselineManifestSchema>) {
    await mkdir(dirname(this.manifestPath), { recursive: true });
    const temporary = `${this.manifestPath}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify(baselineManifestSchema.parse(manifest), null, 2)}\n`,
      {
        mode: 0o600,
      },
    );
    await rename(temporary, this.manifestPath);
  }
}

function keyFor(identity: BaselineIdentity): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        identity.tenantId,
        identity.repositoryId,
        identity.component,
        identity.viewport,
        identity.state,
      ]),
    )
    .digest('hex');
}
