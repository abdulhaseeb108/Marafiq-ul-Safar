import { ApiErrorSchema, HealthResponseSchema } from '@marafiq/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { makeApp } from '../../test/helpers.js';

describe('GET /api/v1/health', () => {
  const { app } = makeApp();

  it('returns 200 with the shared health contract', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const body = HealthResponseSchema.parse(res.body);
    expect(body.status).toBe('ok');
  });

  it('does not advertise the framework', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('returns the standard error envelope for unknown routes', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(ApiErrorSchema.parse(res.body).error.code).toBe('not_found');
  });
});
