// GET /api/reminders — run every morning by Vercel Cron (see vercel.json). Sends, once each:
//   - to each person: "scade domani" for their open tasks due tomorrow
//   - to the administrators: tasks that went late, projects due within 7 days
// Protected by CRON_SECRET: Vercel sends it automatically as "Authorization: Bearer <CRON_SECRET>".
import { adminClient, deliver, romeDay, send } from './_lib.js';

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return send(res, 401, { error: 'Non autorizzato.' });
  try {
    const db = adminClient();
    const today = romeDay(0);
    const tomorrow = romeDay(1);
    const week = romeDay(7);
    const notes = [];

    const [{ data: tasks }, { data: rows }, { data: admins }, { data: profiles }, { data: projects }] = await Promise.all([
      db.from('tasks').select('id,title,due,project_id').not('due', 'is', null).lte('due', tomorrow),
      db.from('task_assignees').select('task_id,user_id,progress,reminded_for,late_noted_for').lt('progress', 100),
      db.from('profiles').select('id').eq('role', 'admin'),
      db.from('profiles').select('id,name'),
      db.from('projects').select('id,code,name,status,due,reminded_for'),
    ]);
    const closed = new Set((projects || []).filter((p) => p.status === 'chiuso').map((p) => p.id));
    const nameOf = (id) => (profiles || []).find((p) => p.id === id)?.name || '';

    for (const t of tasks || []) {
      if (closed.has(t.project_id)) continue;
      for (const a of (rows || []).filter((r) => r.task_id === t.id)) {
        if (t.due === tomorrow && a.reminded_for !== t.due) {
          notes.push({ user_id: a.user_id, text: `Promemoria: «${t.title}» scade domani`, link: '#/scadenze' });
          await db.from('task_assignees').update({ reminded_for: t.due }).eq('task_id', t.id).eq('user_id', a.user_id);
        }
        if (t.due < today && a.late_noted_for !== t.due) {
          for (const ad of admins || []) notes.push({ user_id: ad.id, text: `${nameOf(a.user_id)}: «${t.title}» è in ritardo`, link: '#/scadenze' });
          await db.from('task_assignees').update({ late_noted_for: t.due }).eq('task_id', t.id).eq('user_id', a.user_id);
        }
      }
    }
    for (const p of projects || []) {
      if (p.status === 'chiuso' || !p.due || p.due < today || p.due > week || p.reminded_for === p.due) continue;
      for (const ad of admins || []) notes.push({ user_id: ad.id, text: `Il progetto ${p.code} · ${p.name} va consegnato entro il ${p.due.split('-').reverse().join('/')}`, link: '#/scadenze/progetti' });
      await db.from('projects').update({ reminded_for: p.due }).eq('id', p.id);
    }

    let result = { push: 0, email: 0 };
    if (notes.length) {
      const { data: inserted } = await db.from('notifications').insert(notes).select('id');
      result = await deliver(db, (inserted || []).map((r) => r.id));
    }
    return send(res, 200, { created: notes.length, ...result });
  } catch (e) {
    return send(res, 500, { error: e.message || 'Errore del server.' });
  }
}
