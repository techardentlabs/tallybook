import { isTauri } from './db/index.ts';

export interface UpdateInfo {
  version: string;
  notes: string;
  install: (onProgress: (pct: number) => void) => Promise<void>;
}

export async function findUpdate(): Promise<UpdateInfo | null> {
  if (!isTauri()) return null;
  const { check } = await import('@tauri-apps/plugin-updater');
  const u = await check();
  if (!u) return null;
  return {
    version: u.version,
    notes: u.body ?? '',
    install: async (onProgress) => {
      let total = 0;
      let got = 0;
      await u.downloadAndInstall((e) => {
        if (e.event === 'Started') total = e.data.contentLength ?? 0;
        else if (e.event === 'Progress') {
          got += e.data.chunkLength;
          if (total) onProgress(Math.round((got * 100) / total));
        }
      });
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    },
  };
}

export async function appVersion(): Promise<string> {
  if (!isTauri()) return import.meta.env.VITE_APP_VERSION ?? 'dev';
  const { getVersion } = await import('@tauri-apps/api/app');
  return getVersion();
}
