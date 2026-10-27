// GET /api/backup — administrators download a full copy of the data right now (JSON file).
import { adminClient, caller, exportAll, romeDay, send } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'Metodo non consentito.' });
  try {
    const db = adminClient();
    const who = await caller(req, db);
    if (!who) return send(res, 401, { error: 'Accesso richiesto.' });
    if (who.role !== 'admin') return send(res, 403, { error: 'Solo gli amministratori possono scaricare i dati.' });
    const data = await exportAll(db);
    res.setHeader('content-disposition', `attachment; filename="geco-team-backup-${romeDay(0)}.json"`);
    return send(res, 200, data);
  } catch (e) {
    return send(res, 500, { error: e.message || 'Errore del server.' });
  }
}
