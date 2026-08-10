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
  }): Promise<StudioServer>;
}

export async function loadStudioModule(): Promise<StudioModule> {
  const moduleUrl = import.meta.url.includes('/src/')
    ? new URL('../../studio/src/server.ts', import.meta.url)
    : new URL('./studio/server.js', import.meta.url);
  return (await import(moduleUrl.href)) as StudioModule;
}
