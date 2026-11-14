import { Hono } from 'hono';

export const app = new Hono();

app.get('/health', (c) =>
  c.json({ status: 'ok', service: 'pilgrim-api', contractVersion: 1 }),
);

export default app;
