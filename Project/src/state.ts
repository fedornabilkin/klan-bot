import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface OffsetStore { load(): Promise<number>; save(offset: number): Promise<void> }

export function fileOffsetStore(file: string): OffsetStore {
  return {
    async load() {
      let source: string;
      try { source = await readFile(file, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw new Error('Cannot read bot offset file.'); }
      try {
        const value = JSON.parse(source) as { offset?: unknown };
        if (!Number.isSafeInteger(value.offset) || Number(value.offset) < 0) throw new Error();
        return Number(value.offset);
      } catch { throw new Error('Bot offset file is invalid; inspect it before restarting.'); }
    },
    async save(offset) {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid bot offset.');
      try {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(`${file}.tmp`, JSON.stringify({ offset }), { encoding: 'utf8', mode: 0o600 });
        await rename(`${file}.tmp`, file);
      } catch { throw new Error('Cannot save bot offset file.'); }
    },
  };
}
