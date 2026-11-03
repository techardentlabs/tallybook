import { isTauri } from './db/index.ts';

export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  if (bytes.length >= 4 && bytes[1] === 0 && bytes[3] === 0) return new TextDecoder('utf-16le').decode(bytes);
  return new TextDecoder('utf-8').decode(bytes);
}

export async function pickXmlFile(): Promise<{ name: string; text: string } | null> {
  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { readFile } = await import('@tauri-apps/plugin-fs');
    const path = await open({ multiple: false, filters: [{ name: 'Tally XML', extensions: ['xml'] }] });
    if (!path || Array.isArray(path)) return null;
    const bytes = await readFile(path);
    return { name: path.split(/[\\/]/).pop() ?? path, text: decodeText(bytes) };
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xml,text/xml,application/xml';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      resolve({ name: f.name, text: decodeText(new Uint8Array(await f.arrayBuffer())) });
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

export async function saveTextFile(suggested: string, text: string, mime = 'text/xml'): Promise<string | null> {
  if (isTauri()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    const path = await save({ defaultPath: suggested });
    if (!path) return null;
    await writeTextFile(path, text);
    return path;
  }
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = suggested;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return suggested;
}

export async function pickJsonFile(): Promise<{ name: string; text: string } | null> {
  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { readFile } = await import('@tauri-apps/plugin-fs');
    const path = await open({ multiple: false, filters: [{ name: 'TallyBook backup', extensions: ['json', 'tbbackup'] }] });
    if (!path || Array.isArray(path)) return null;
    const bytes = await readFile(path);
    return { name: path.split(/[\\/]/).pop() ?? path, text: decodeText(bytes) };
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.tbbackup,application/json';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      resolve({ name: f.name, text: decodeText(new Uint8Array(await f.arrayBuffer())) });
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}
