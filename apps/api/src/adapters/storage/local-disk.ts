import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { StorageAdapter } from './storage.js';

/**
 * Stores files in a local folder. For development only: the folder is not
 * backed up and is lost if the server is rebuilt. Production uses R2.
 */
export class LocalDiskStorage implements StorageAdapter {
  readonly name = 'local-disk';
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathFor(key: string): string {
    const path = resolve(this.root, key);
    if (!path.startsWith(this.root + sep))
      throw new Error('Storage key escapes the storage folder');
    return path;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }
}
