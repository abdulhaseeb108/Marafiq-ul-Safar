import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { StorageAdapter } from './storage.js';

export interface R2Options {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/** Cloudflare R2 through its S3-compatible API. The bucket must be private. */
export class R2Storage implements StorageAdapter {
  readonly name = 'r2';
  private readonly client: S3Client;

  constructor(private readonly options: R2Options) {
    this.client = new S3Client({
      region: 'auto',
      endpoint: options.endpoint,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  async put(key: string, data: Buffer, mimeType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: data,
        ContentType: mimeType,
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
    );
    if (!result.Body) throw new Error(`No stored file at ${key}`);
    return Buffer.from(await result.Body.transformToByteArray());
  }
}
