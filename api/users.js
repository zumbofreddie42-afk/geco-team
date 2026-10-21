// /api/users — accounts, administrators only.
//   POST   { name, email, password, role, job }  creates an account (the person can then sign in)
//   PATCH  { id, password }                       sets a new password for someone who forgot it
//   DELETE { id }                                  removes the account (and their rows) for good
import { adminClient, caller, readBody, send } from './_lib.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PALETTE = ['#12428a', '#3f6cb3', '#0e5f8a', '#4a4fb0', '#1f3b70', '#2c5aa0', '#0b4f6c'];

export default async function handler(req, res) {
  try {
    const db = adminClient();
    const who = await caller(req, db);
    if (!who) return send(res, 401, { error: 'Accesso richiesto.' });
    if (who.role !== 'admin') return send(res, 403, { error: 'Solo gli amministratori possono gestire gli account.' });
    const body = await readBody(req);

    if (req.method === 'POST') {
      const name = String(body.name || '').trim().slice(0, 60);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const role = body.role === 'admin' ? 'admin' : 'member';
      const job = String(body.job || '').trim().slice(0, 60);
      if (!name || !EMAIL_RE.test(email)) return send(res, 400, { error: 'Nome o email non validi.' });
      if (password.length < 8) return send(res, 400, { error: 'La password deve avere almeno 8 caratteri.' });
      const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name } });
      if (error) return send(res, 400, { error: /already/i.test(error.message) ? 'Esiste già un account con questa email.' : error.message });
      const { count } = await db.from('profiles').select('id', { count: 'exact', head: true });
      const profile = { id: data.user.id, name, email, role, job, color: PALETTE[(count || 0) % PALETTE.length] };
      const ins = await db.from('profiles').insert(profile);
      if (ins.error) {
        await db.auth.admin.deleteUser(data.user.id);
        return send(res, 500, { error: 'Account non creato, riprova.' });
      }
      return send(res, 200, { profile });
    }

    if (req.method === 'PATCH') {
      const password = String(body.password || '');
      if (!body.id || password.length < 8) return send(res, 400, { error: 'La password deve avere almeno 8 caratteri.' });
      const { error } = await db.auth.admin.updateUserById(body.id, { password });
      if (error) return send(res, 400, { error: error.message });
      return send(res, 200, { ok: true });
    }

    if (req.method === 'DELETE') {
      if (!body.id) return send(res, 400, { error: 'Richiesta non valida.' });
      if (body.id === who.id) return send(res, 400, { error: 'Non puoi togliere l’accesso a te stesso.' });
      const { data: target } = await db.from('profiles').select('role').eq('id', body.id).maybeSingle();
      if (target?.role === 'admin') {
        const { count } = await db.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'admin');
        if ((count || 0) <= 1) return send(res, 400, { error: 'Deve restare almeno un amministratore.' });
      }
      const { error } = await db.auth.admin.deleteUser(body.id);
      if (error) return send(res, 400, { error: error.message });
      return send(res, 200, { ok: true });
    }

    return send(res, 405, { error: 'Metodo non consentito.' });
  } catch (e) {
    return send(res, 500, { error: e.message || 'Errore del server.' });
  }
}
