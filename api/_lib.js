// Shared server code for the Vercel functions (files starting with "_" are not public routes).
// Uses the Supabase SERVICE ROLE key, which bypasses access rules: it must only ever live in server env vars.
import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';

const env = process.env;

export function adminClient() {
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
  if (!url || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Configurazione del server incompleta.');
  return createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function send(res, status, body) {
  res.status(status).setHeader('content-type', 'application/json').send(JSON.stringify(body));
}

export async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  return {};
}

/** The signed-in person calling the function (from their Supabase token), with their profile. */
export async function caller(req, db) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) return null;
  const { data: profile } = await db.from('profiles').select('id,name,role').eq('id', data.user.id).maybeSingle();
  return profile || null;
}

/** Today in Italy as YYYY-MM-DD, whatever the server time zone is. */
export function romeDay(offsetDays = 0, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const d = new Date(`${parts}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

let vapidReady = false;
function setupVapid() {
  if (vapidReady) return true;
  const pub = env.VAPID_PUBLIC_KEY || env.VITE_VAPID_PUBLIC_KEY;
  if (!pub || !env.VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(env.VAPID_SUBJECT || 'mailto:onelinkrc@gmail.com', pub, env.VAPID_PRIVATE_KEY);
  vapidReady = true;
  return true;
}

async function sendEmail(to, text, link) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return false;
  const url = `${env.APP_URL || ''}/${link || ''}`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [to],
      subject: `Geco Team: ${text.slice(0, 70)}`,
      text: `${text}\n\nApri l'area team: ${url}\n\nRicevi questa email perché la notifica non è attiva sul tuo telefono.`,
    }),
  });
  return res.ok;
}

/**
 * Delivers notification rows that were not sent yet: phone push to every device of the person; if none works,
 * an email (when Resend is configured). Each row is marked as sent so it never goes out twice.
 */
export async function deliver(db, ids) {
  if (!ids.length) return { push: 0, email: 0 };
  const { data: rows } = await db.from('notifications').select('id,user_id,text,link,sent').in('id', ids).eq('sent', false);
  if (!rows?.length) return { push: 0, email: 0 };
  await db.from('notifications').update({ sent: true }).in('id', rows.map((r) => r.id));
  const users = [...new Set(rows.map((r) => r.user_id))];
  const [{ data: subs }, { data: profiles }] = await Promise.all([
    db.from('push_subscriptions').select('id,user_id,endpoint,p256dh,auth').in('user_id', users),
    db.from('profiles').select('id,email').in('id', users),
  ]);
  const canPush = setupVapid();
  let push = 0;
  let email = 0;
  for (const n of rows) {
    let delivered = false;
    if (canPush) {
      for (const s of (subs || []).filter((x) => x.user_id === n.user_id)) {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            JSON.stringify({ title: 'Geco Team', body: n.text, link: n.link, tag: n.id }), { TTL: 60 * 60 * 24 });
          delivered = true;
          push += 1;
        } catch (e) {
          // The phone uninstalled the app or revoked permission: forget that device.
          if (e.statusCode === 404 || e.statusCode === 410) await db.from('push_subscriptions').delete().eq('id', s.id);
        }
      }
    }
    if (!delivered) {
      const to = (profiles || []).find((p) => p.id === n.user_id)?.email;
      if (to && (await sendEmail(to, n.text, n.link).catch(() => false))) email += 1;
    }
  }
  return { push, email };
}

// ---------- backups ----------
const BACKUP_TABLES = ['profiles', 'settings', 'projects', 'project_members', 'tasks', 'task_assignees', 'comments', 'memos', 'memo_recipients', 'activity_log'];
const BUCKET = 'backups';
const KEEP = 8;

/** Every table the team works with, as one JSON object (notifications and phone subscriptions are left out). */
export async function exportAll(db) {
  const out = { app: 'geco-team', createdAt: new Date().toISOString(), tables: {} };
  for (const t of BACKUP_TABLES) {
    const { data, error } = await db.from(t).select('*');
    if (error) throw new Error(`${t}: ${error.message}`);
    out.tables[t] = data;
  }
  return out;
}

/** Saves a copy in a private Supabase Storage bucket and keeps only the latest KEEP copies. */
export async function saveBackup(db, day) {
  await db.storage.createBucket(BUCKET, { public: false }).catch(() => {});
  const body = JSON.stringify(await exportAll(db));
  const name = `backup-${day}.json`;
  const { error } = await db.storage.from(BUCKET).upload(name, body, { contentType: 'application/json', upsert: true });
  if (error) throw new Error(error.message);
  const { data: files } = await db.storage.from(BUCKET).list('', { limit: 100, sortBy: { column: 'name', order: 'desc' } });
  const old = (files || []).filter((f) => f.name.startsWith('backup-')).slice(KEEP).map((f) => f.name);
  if (old.length) await db.storage.from(BUCKET).remove(old);
  return name;
}
