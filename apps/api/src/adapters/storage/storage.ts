import type { RateSheetMimeType } from '@marafiq/shared';
import type { DocumentIntelligenceMimeType } from '../../modules/document-intelligence/document-formats.js';

/**
 * Where original rate sheet files live. The rest of the API only knows this
 * interface, so the vendor can change (CLAUDE.md conventions).
 */
export interface StorageAdapter {
  readonly name: string;
  put(key: string, data: Buffer, mimeType: string): Promise<void>;
  /** Throws if the key does not exist. */
  get(key: string): Promise<Buffer>;
}

const EXTENSIONS: Record<RateSheetMimeType, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

const DOCUMENT_EXTENSIONS: Record<DocumentIntelligenceMimeType, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/csv': 'csv',
  'application/octet-stream': 'bin',
};

/**
 * Keys are built only from ids and the content hash, never from the uploaded
 * file name, so a hostile name cannot escape the bucket folder.
 */
export function rateSheetKey(
  supplierId: string,
  sha256: string,
  mimeType: RateSheetMimeType,
): string {
  if (!/^[0-9a-f]{24}$/i.test(supplierId) || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error('Invalid storage key parts');
  }
  return `rate-sheets/${supplierId}/${sha256}.${EXTENSIONS[mimeType]}`;
}

/** Original documents accepted by document intelligence share the original-file namespace. */
export function sourceDocumentKey(
  supplierId: string,
  sha256: string,
  mimeType: DocumentIntelligenceMimeType,
): string {
  if (!/^[0-9a-f]{24}$/i.test(supplierId) || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error('Invalid storage key parts');
  }
  return `rate-sheets/${supplierId}/${sha256}.${DOCUMENT_EXTENSIONS[mimeType]}`;
}

/** Keeps files in memory. For tests. */
export class MemoryStorage implements StorageAdapter {
  readonly name = 'memory';
  private readonly files = new Map<string, Buffer>();

  async put(key: string, data: Buffer): Promise<void> {
    this.files.set(key, Buffer.from(data));
  }

  async get(key: string): Promise<Buffer> {
    const data = this.files.get(key);
    if (!data) throw new Error(`No stored file at ${key}`);
    return data;
  }
}
