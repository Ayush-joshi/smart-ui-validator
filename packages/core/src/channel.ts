import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SmartUiError } from './errors.js';
import { redactSensitiveText } from './security.js';

export const channelEventSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    eventId: z.string().min(1).max(500),
    workspaceId: z.string().min(1).max(200),
    channelId: z.string().min(1).max(200),
    threadId: z.string().min(1).max(200),
    userId: z.string().min(1).max(200),
    projectId: z.string().min(1).max(200),
    text: z.string().max(20_000),
    attachmentHashes: z
      .array(z.string().regex(/^sha256:[a-f0-9]{64}$/))
      .max(20)
      .default([]),
    receivedAt: z.string().datetime(),
  })
  .strict();

export const channelOutputPolicySchema = z
  .object({
    allowSource: z.boolean().default(false),
    allowScreenshots: z.boolean().default(false),
    allowPrivateDesign: z.boolean().default(false),
    allowMemory: z.boolean().default(false),
    allowArtifactLinks: z.boolean().default(true),
  })
  .strict();

export interface ChannelRequest {
  requestId: string;
  tenantId: string;
  userId: string;
  projectId: string;
  origin: { workspaceId: string; channelId: string; threadId: string; eventId: string };
  untrustedText: string;
  attachmentHashes: string[];
  approvalRequired: boolean;
}

/** Optional OpenClaw/Slack boundary. It maps scope and approvals but never owns orchestration. */
export class OpenClawSlackAdapter {
  private readonly processed = new Map<string, ChannelRequest>();

  constructor(
    private readonly workspaceTenants: Record<string, string>,
    private readonly outputPolicy: z.input<typeof channelOutputPolicySchema> = {},
  ) {}

  accept(input: unknown): { duplicate: boolean; request: ChannelRequest } {
    const event = channelEventSchema.parse(input);
    const existing = this.processed.get(event.eventId);
    if (existing) return { duplicate: true, request: existing };
    const tenantId = this.workspaceTenants[event.workspaceId];
    if (!tenantId)
      throw new SmartUiError(
        'POLICY_VIOLATION',
        'Slack workspace is not mapped to an allowed tenant.',
      );
    const request: ChannelRequest = {
      requestId: createHash('sha256').update(`${event.workspaceId}:${event.eventId}`).digest('hex'),
      tenantId,
      userId: event.userId,
      projectId: event.projectId,
      origin: {
        workspaceId: event.workspaceId,
        channelId: event.channelId,
        threadId: event.threadId,
        eventId: event.eventId,
      },
      untrustedText: redactSensitiveText(event.text),
      attachmentHashes: event.attachmentHashes,
      approvalRequired: looksMutating(event.text),
    };
    this.processed.set(event.eventId, request);
    return { duplicate: false, request };
  }

  assertApproval(
    request: ChannelRequest,
    approval:
      | { workspaceId: string; channelId: string; threadId: string; userId: string }
      | undefined,
  ): void {
    if (!request.approvalRequired) return;
    if (
      !approval ||
      approval.workspaceId !== request.origin.workspaceId ||
      approval.channelId !== request.origin.channelId ||
      approval.threadId !== request.origin.threadId ||
      approval.userId !== request.userId
    ) {
      throw new SmartUiError(
        'POLICY_VIOLATION',
        'Code-changing channel runs require approval by the originating user in the originating thread.',
      );
    }
  }

  filterOutbound(input: {
    text: string;
    containsSource?: boolean;
    containsScreenshots?: boolean;
    containsPrivateDesign?: boolean;
    containsMemory?: boolean;
    containsArtifactLinks?: boolean;
  }): string {
    const policy = channelOutputPolicySchema.parse(this.outputPolicy);
    const denied =
      (input.containsSource && !policy.allowSource) ||
      (input.containsScreenshots && !policy.allowScreenshots) ||
      (input.containsPrivateDesign && !policy.allowPrivateDesign) ||
      (input.containsMemory && !policy.allowMemory) ||
      (input.containsArtifactLinks && !policy.allowArtifactLinks);
    if (denied)
      throw new SmartUiError(
        'POLICY_VIOLATION',
        'Channel output policy blocks this content class.',
      );
    return redactSensitiveText(input.text);
  }
}

function looksMutating(text: string): boolean {
  return /\b(fix|repair|implement|change|edit|write|update|delete|forget|confirm)\b/i.test(text);
}
