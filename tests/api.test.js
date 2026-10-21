import { describe, expect, it } from 'vitest';
import { romeDay } from '../api/_lib.js';
import notify from '../api/notify.js';
import reminders from '../api/reminders.js';
import users from '../api/users.js';

function fakeRes() {
  const res = { statusCode: 0, body: null, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; return res; };
  res.send = (b) => { res.body = JSON.parse(b); return res; };
  return res;
}

describe('server functions', () => {
  it('refuses the morning reminders without the cron secret', async () => {
    process.env.CRON_SECRET = 'segreto';
    const res = fakeRes();
    await reminders({ method: 'GET', headers: { authorization: 'Bearer sbagliato' } }, res);
    expect(res.statusCode).toBe(401);
  });

  it('only accepts POST for notifications', async () => {
    const res = fakeRes();
    await notify({ method: 'GET', headers: {} }, res);
    expect(res.statusCode).toBe(405);
  });

  it('does not leak details when the server is not configured', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const res = fakeRes();
    await users({ method: 'POST', headers: {}, body: {} }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('Configurazione del server incompleta.');
  });

  it('computes days on the Italian calendar', () => {
    // 23:30 UTC on 21 October is already 22 October in Italy.
    expect(romeDay(0, new Date('2026-10-21T23:30:00Z'))).toBe('2026-10-22');
    expect(romeDay(1, new Date('2026-10-21T10:00:00Z'))).toBe('2026-10-22');
  });
});
