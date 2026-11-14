import { describe, expect, it } from 'vitest';
import { app } from '../src/index.js';

describe('GET /health', () => {
  it('returns the exact contract', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.text()).toBe('{"status":"ok","service":"pilgrim-api","contractVersion":1}');
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('rejects %s with 404', async (method) => {
    const res = await app.request('/health', { method });
    expect(res.status).toBe(404);
  });
});
