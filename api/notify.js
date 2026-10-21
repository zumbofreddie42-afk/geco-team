// POST /api/notify { ids: [...] } — sends the notifications the app has just created (push, or email as fallback).
// Only signed-in people can call it, and only rows created in the last 10 minutes and not sent yet are delivered.
import { adminClient, caller, deliver, readBody, send } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Metodo non consentito.' });
  try {
    const db = adminClient();
    const who = await caller(req, db);
    if (!who) return send(res, 401, { error: 'Accesso richiesto.' });
    const { ids } = await readBody(req);
    if (!Array.isArray(ids) || ids.length > 50 || ids.some((x) => typeof x !== 'string')) return send(res, 400, { error: 'Richiesta non valida.' });
    const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: fresh } = await db.from('notifications').select('id').in('id', ids).gte('created_at', since);
    const result = await deliver(db, (fresh || []).map((r) => r.id));
    return send(res, 200, result);
  } catch (e) {
    return send(res, 500, { error: e.message || 'Errore del server.' });
  }
}
