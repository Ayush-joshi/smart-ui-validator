export interface StudioHealth {
  status: 'ready' | 'degraded';
  checks: Record<string, boolean>;
}

export interface StudioServer {
  url: string;
  workspaceRoot: string;
  health(): Promise<StudioHealth>;
  close(): Promise<void>;
}

interface StudioModule {
  initializeStudioWorkspace(workspaceRoot: string): Promise<{
    workspaceRoot: string;
    workspaceId: string;
    initialized: boolean;
  }>;
  startStudioServer(options: {
    workspaceRoot: string;
    port?: number;
    retentionMs?: number;
    /** Repository root that enables the validate-UI work type; the browser cannot grant a new root. */
    targetRoot?: string;
    /** Verified `task.json` imported for review at startup. */
    reviewTask?: string;
  }): Promise<StudioServer>;
}

export async function loadStudioModule(): Promise<StudioModule> {
  const moduleUrl = import.meta.url.includes('/src/')
    ? new URL('../../studio/src/server.ts', import.meta.url)
    : new URL('./studio/server.js', import.meta.url);
  return (await import(moduleUrl.href)) as StudioModule;
}
