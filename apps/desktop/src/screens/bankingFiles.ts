import { isTauri } from '../db/index.ts';
import { decodeText } from '../files.ts';

export async function pickTextFile(label: string, extensions: string[]): Promise<{ name: string; text: string } | null> {
  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { readFile } = await import('@tauri-apps/plugin-fs');
    const path = await open({ multiple: false, filters: [{ name: label, extensions }] });
    if (!path || Array.isArray(path)) return null;
    const bytes = await readFile(path);
    return { name: path.split(/[\\/]/).pop() ?? path, text: decodeText(bytes) };
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = extensions.map((e) => `.${e}`).join(',');
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      resolve({ name: f.name, text: decodeText(new Uint8Array(await f.arrayBuffer())) });
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}
