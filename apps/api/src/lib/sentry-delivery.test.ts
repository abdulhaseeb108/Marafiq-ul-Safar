/**
 * Sentry end to end: with SENTRY_DSN set, an error reaches the Sentry server,
 * and what arrives holds the error class, stack and tags but none of the
 * customer data the error message carried. A local HTTP server stands in for
 * Sentry's ingest endpoint, so nothing leaves the machine.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeMonitoring, initMonitoring, reportError } from './monitoring.js';

let server: Server;
const received: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      received.push(
        (req.headers['content-encoding'] === 'gzip' ? gunzipSync(body) : body).toString('utf8'),
      );
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  await closeMonitoring();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

class InquiryFailedError extends Error {
  override name = 'InquiryFailedError';
}

describe('Sentry delivery (SENTRY_DSN set)', () => {
  it('sends the error class, stack and tags, and none of the personal data in the message', async () => {
    const { port } = server.address() as AddressInfo;
    const on = initMonitoring({
      dsn: `http://publickey@127.0.0.1:${port}/1`,
      environment: 'test',
      release: 'test-release',
    });
    expect(on).toBe(true);

    reportError(
      new InquiryFailedError('Ali Khan 03001234567 ali@example.com token=abcdefabcdefabcdef'),
      { route: '/api/v1/public/inquiries', requestId: 'req-1' },
    );
    // close() flushes the queue before it returns.
    await closeMonitoring();

    const all = received.join('\n');
    expect(all).toContain('InquiryFailedError');
    expect(all).toContain('/api/v1/public/inquiries');
    expect(all).toContain('req-1');
    expect(all).toContain('test-release');
    expect(all).toContain('[redacted]');
    for (const secret of ['Ali Khan', '03001234567', 'ali@example.com', 'abcdefabcdefabcdef']) {
      expect(all).not.toContain(secret);
    }
  });
});
