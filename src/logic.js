// Pure helpers shared by the UI and both data adapters (no DOM, no network): easy to test.

export const CATS = [
  { id: 'priv', label: 'Clienti privati', prefix: 'PRIV' },
  { id: 'pub', label: 'Clienti pubblici', prefix: 'PUB' },
  { id: 'gara', label: 'Bandi di gara', prefix: 'GARA' },
];
export const PSTATUS = [
  { id: 'preventivo', label: 'In preventivo' },
  { id: 'corso', label: 'In corso' },
  { id: 'sospeso', label: 'Sospeso' },
  { id: 'chiuso', label: 'Chiuso (archivio)' },
];
export const PRIO = [
  { id: 'alta', label: 'Alta' },
  { id: 'media', label: 'Media' },
  { id: 'bassa', label: 'Bassa' },
];
const PRIO_RANK = { alta: 0, media: 1, bassa: 2 };

export const byId = (list, id) => list.find((x) => x.id === id) || null;
export const category = (id) => byId(CATS, id) || CATS[0];
export const pstatus = (id) => byId(PSTATUS, id) || PSTATUS[1];
export const prio = (id) => byId(PRIO, id) || PRIO[1];

// ---------- dates (local calendar days) ----------
const pad = (n) => String(n).padStart(2, '0');
export const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayIso = (now = new Date()) => isoDay(now);
export function addDays(n, now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() + n);
  return isoDay(d);
}
export function daysFromToday(s, now = new Date()) {
  return Math.round((new Date(`${s}T00:00:00`) - new Date(`${todayIso(now)}T00:00:00`)) / 86400000);
}
const WD = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
const MO = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
export function fmtDate(s, now = new Date()) {
  if (!s) return 'senza scadenza';
  const n = daysFromToday(s, now);
  if (n === 0) return 'oggi';
  if (n === 1) return 'domani';
  if (n === -1) return 'ieri';
  const d = new Date(`${s}T00:00:00`);
  return `${WD[d.getDay()]} ${d.getDate()} ${MO[d.getMonth()]}`;
}
export function fmtAgo(at, now = Date.now()) {
  const ms = typeof at === 'string' ? Date.parse(at) : at;
  const min = Math.round((now - ms) / 60000);
  if (min < 1) return 'ora';
  if (min < 60) return `${min} min fa`;
  if (min < 24 * 60) return `${Math.round(min / 60)} h fa`;
  const d = new Date(ms);
  return `${d.getDate()} ${MO[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------- tasks and progress (each assignee has their own percentage) ----------
export const assigneeOf = (task, userId) => task.assignees.find((a) => a.userId === userId) || null;
export const taskAvg = (task) => avg(task.assignees.map((a) => a.progress));
export function avg(values) {
  if (!values.length) return 0;
  return Math.round(values.reduce((s, v) => s + v, 0) / values.length);
}
export function isLate(due, progress, now = new Date()) {
  return progress < 100 && !!due && daysFromToday(due, now) < 0;
}
export function status(due, progress, now = new Date()) {
  if (progress >= 100) return { cls: 'ok', label: 'Completata' };
  if (isLate(due, progress, now)) return { cls: 'late', label: 'In ritardo' };
  if (due && daysFromToday(due, now) === 0) return { cls: 'today', label: 'Scade oggi' };
  if (progress === 0) return { cls: 'idle', label: 'Da iniziare' };
  return { cls: 'run', label: 'In corso' };
}
/** Open items first, then by deadline, then by priority. `progressOf` picks the percentage to judge. */
export function byUrgency(progressOf = taskAvg) {
  return (a, b) => {
    const da = progressOf(a) >= 100 ? 1 : 0;
    const db = progressOf(b) >= 100 ? 1 : 0;
    if (da !== db) return da - db;
    const ad = a.due || '9999';
    const bd = b.due || '9999';
    if (ad !== bd) return ad < bd ? -1 : 1;
    return PRIO_RANK[a.priority] - PRIO_RANK[b.priority];
  };
}

// ---------- projects ----------
export function nextCode(projects, catId) {
  let max = 0;
  for (const p of projects) if (p.cat === catId && p.code) max = Math.max(max, Number(p.code.split('-')[1]) || 0);
  return `${category(catId).prefix}-${String(max + 1).padStart(3, '0')}`;
}
/** Same rule as the database: admins see everything; others only projects they are members of. */
export function canSeeProject(project, user) {
  if (!user) return false;
  return user.role === 'admin' || project.members.includes(user.id);
}
/** Ids added and removed between two lists (used to notify only the people who are new). */
export function diffIds(before, after) {
  return {
    added: after.filter((id) => !before.includes(id)),
    removed: before.filter((id) => !after.includes(id)),
  };
}

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
export const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
