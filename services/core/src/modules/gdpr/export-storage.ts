import { createHash, createHmac } from 'node:crypto';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { loadConfig } from '@oe/ts-common/config';
import { z } from 'zod';

export const EXPORTS_BUCKET = 'exports';

export const storageConfigSchema = z.object({
  /** `http://minio:9000`: where core talks to MinIO. */
  CORE_MINIO_ENDPOINT: z.string().url(),
  /** Origin browsers reach MinIO at; presigned URLs are signed for it. Defaults to the endpoint. */
  CORE_MINIO_PUBLIC_ENDPOINT: z.string().url().optional(),
  CORE_MINIO_ACCESS_KEY: z.string().min(1),
  CORE_MINIO_SECRET_KEY: z.string().min(1),
  CORE_MINIO_REGION: z.string().min(1).default('us-east-1'),
});
export type StorageConfig = z.infer<typeof storageConfigSchema>;

/** RFC 3986 encoding, as SigV4 wants it. */
const enc = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest();

/** GDPR export files in the MinIO `exports` bucket. */
export class ExportStorage {
  private readonly s3: S3Client;

  constructor(private readonly cfg: StorageConfig) {
    this.s3 = new S3Client({
      endpoint: cfg.CORE_MINIO_ENDPOINT,
      region: cfg.CORE_MINIO_REGION,
      forcePathStyle: true,
      credentials: { accessKeyId: cfg.CORE_MINIO_ACCESS_KEY, secretAccessKey: cfg.CORE_MINIO_SECRET_KEY },
    });
  }

  static fromEnv(): ExportStorage {
    return new ExportStorage(loadConfig(storageConfigSchema));
  }

  async put(key: string, body: string): Promise<void> {
    await this.s3.send(new PutObjectCommand({ Bucket: EXPORTS_BUCKET, Key: key, Body: body, ContentType: 'application/json' }));
  }

  async remove(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: EXPORTS_BUCKET, Key: key }));
  }

  /**
   * SigV4 query-string presigned GET, valid `expiresIn` seconds from `signedAt`. Signing at a
   * fixed instant (the request's completion) keeps the URL and its expiry stable across reads.
   * ponytail: hand-rolled because `@aws-sdk/s3-request-presigner` is not a core dependency.
   */
  presignGet(key: string, signedAt: Date, expiresIn: number): string {
    const base = new URL(this.cfg.CORE_MINIO_PUBLIC_ENDPOINT ?? this.cfg.CORE_MINIO_ENDPOINT);
    const path = `/${EXPORTS_BUCKET}/${key.split('/').map(enc).join('/')}`;
    const amzDate = signedAt.toISOString().replace(/[-:]|\.\d{3}/g, '');
    const day = amzDate.slice(0, 8);
    const scope = `${day}/${this.cfg.CORE_MINIO_REGION}/s3/aws4_request`;
    // Already in the byte order SigV4 sorts parameters by.
    const query = [
      ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
      ['X-Amz-Credential', `${this.cfg.CORE_MINIO_ACCESS_KEY}/${scope}`],
      ['X-Amz-Date', amzDate],
      ['X-Amz-Expires', String(expiresIn)],
      ['X-Amz-SignedHeaders', 'host'],
    ]
      .map(([k, v]) => `${enc(k!)}=${enc(v!)}`)
      .join('&');
    const canonical = ['GET', path, query, `host:${base.host}`, '', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonical).digest('hex')].join('\n');
    let signingKey: string | Buffer = `AWS4${this.cfg.CORE_MINIO_SECRET_KEY}`;
    for (const part of [day, this.cfg.CORE_MINIO_REGION, 's3', 'aws4_request']) signingKey = hmac(signingKey, part);
    const signature = createHmac('sha256', signingKey).update(toSign).digest('hex');
    return `${base.protocol}//${base.host}${path}?${query}&X-Amz-Signature=${signature}`;
  }
}
