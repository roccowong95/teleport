import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
export class EncryptedStore {
  constructor(path, safeStorage) { this.path = path; this.crypto = safeStorage; }
  requireEncryption() {
    if (!this.crypto.isEncryptionAvailable() || this.crypto.getSelectedStorageBackend?.() === 'basic_text') throw new Error('Secure OS key storage unavailable; refusing to store credentials.');
  }
  async load() {
    this.requireEncryption();
    try { return JSON.parse(this.crypto.decryptString(await readFile(this.path))); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async save(state) {
    this.requireEncryption();
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const bytes = this.crypto.encryptString(JSON.stringify(state));
    await writeFile(`${this.path}.tmp`, bytes, { mode: 0o600 });
    await rename(`${this.path}.tmp`, this.path);
  }
}
