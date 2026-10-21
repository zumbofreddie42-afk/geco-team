// Trial mode: the same API as the Supabase adapter, kept in this browser (localStorage). Used when the app has no
// Supabase settings, to try the interface. It starts EMPTY: only the people, no projects, tasks or memos.
import { byId, canSeeProject, diffIds, nextCode } from '../logic.js';

const KEY = 'geco-team-local-v1';
const USER_KEY = 'geco-team-local-user';

function seed() {
  const p = (id, name, role, color) => ({ id, name, email: `${name.toLowerCase()}@esempio.it`, role, job: '', color });
  return {
    settings: { approval: true },
    profiles: [
      p('a1', 'Giorgio', 'admin', '#0b1f3f'),
      p('a2', 'Fortunato', 'admin', '#1d3a6b'),
      p('u1', 'Luca', 'member', '#12428a'),
      p('u2', 'Angela', 'member', '#3f6cb3'),
      p('u3', 'Martina', 'member', '#0e5f8a'),
      p('u4', 'Seby', 'member', '#4a4fb0'),
      p('u5', 'Sergio', 'member', '#1f3b70'),
      p('u6', 'Margherita', 'member', '#2c5aa0'),
    ],
    projects: [],
    tasks: [],
    memos: [],
    notifications: [],
    log: [],
  };
}

export function createLocalApi() {
  let db = read();
  let me = null;
  const listeners = new Set();
  try { me = sessionStorage.getItem(USER_KEY); } catch { /* ignore */ }

  function read() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return JSON.parse(raw);
    } catch { /* storage blocked */ }
    return seed();
  }
  function write() {
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* memory only */ }
  }
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
  const user = () => byId(db.profiles, me);
  const isAdmin = () => user()?.role === 'admin';
  function requireAdmin() { if (!isAdmin()) throw new Error('Solo gli amministratori possono farlo.'); }
  function joinProject(projectId, userId) {
    const pr = byId(db.projects, projectId);
    if (pr && !pr.members.includes(userId)) pr.members.push(userId);
  }
  function commit() { write(); }

  // Other tabs of the same browser stay in sync, like realtime updates in the real app.
  window.addEventListener('storage', (e) => { if (e.key === KEY) { db = read(); listeners.forEach((cb) => cb()); } });

  return {
    mode: 'local',
    async getUser() { return user(); },
    async listLoginProfiles() { return db.profiles; },
    async signInAs(id) { me = id; try { sessionStorage.setItem(USER_KEY, id); } catch { /* ignore */ } return user(); },
    async signOut() { me = null; try { sessionStorage.removeItem(USER_KEY); } catch { /* ignore */ } },
    async changePassword() { throw new Error('In modalità prova non ci sono password.'); },
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },

    async load() {
      const u = user();
      const projects = db.projects.filter((p) => canSeeProject(p, u));
      const visible = new Set(projects.map((p) => p.id));
      return {
        settings: { ...db.settings },
        profiles: db.profiles.map((p) => ({ ...p })),
        projects: structuredClone(projects),
        tasks: structuredClone(db.tasks.filter((t) => visible.has(t.projectId))),
        memos: structuredClone(db.memos.filter((m) => isAdmin() || m.recipients.some((r) => r.userId === me))),
        notifications: db.notifications.filter((n) => n.userId === me).slice(0, 60),
        log: isAdmin() ? db.log.slice(0, 60) : [],
      };
    },

    async saveProject({ id, cat, name, status, due, members }) {
      requireAdmin();
      let pr = id ? byId(db.projects, id) : null;
      if (pr) Object.assign(pr, { name, status, due: due || null });
      else {
        pr = { id: uid(), cat, code: nextCode(db.projects, cat), name, status, due: due || null, members: [] };
        db.projects.push(pr);
      }
      // Assignees always keep seeing the project.
      const assignees = db.tasks.filter((t) => t.projectId === pr.id).flatMap((t) => t.assignees.map((a) => a.userId));
      const before = pr.members.slice();
      pr.members = [...new Set([...members, ...assignees])];
      commit();
      return { project: structuredClone(pr), ...diffIds(before, pr.members) };
    },
    async deleteProject(id) {
      requireAdmin();
      db.tasks = db.tasks.filter((t) => t.projectId !== id);
      db.projects = db.projects.filter((p) => p.id !== id);
      commit();
    },
    async setProjectStatus(id, status) { requireAdmin(); byId(db.projects, id).status = status; commit(); },

    async saveTask({ id, projectId, title, notes, due, priority, assignees }) {
      requireAdmin();
      let t = id ? byId(db.tasks, id) : null;
      const before = t ? t.assignees.map((a) => a.userId) : [];
      if (t) Object.assign(t, { projectId, title, notes, due: due || null, priority });
      else {
        t = { id: uid(), projectId, title, notes, due: due || null, priority, assignees: [], comments: [], createdAt: new Date().toISOString() };
        db.tasks.push(t);
      }
      // Keep each remaining person's percentage; newcomers start from 0.
      t.assignees = assignees.map((userId) => t.assignees.find((a) => a.userId === userId) || { userId, progress: 0, pending: null });
      assignees.forEach((u) => joinProject(projectId, u));
      commit();
      return { task: structuredClone(t), ...diffIds(before, assignees) };
    },
    async deleteTask(id) { requireAdmin(); db.tasks = db.tasks.filter((t) => t.id !== id); commit(); },

    async setMyProgress(taskId, value) {
      const a = byId(db.tasks, taskId)?.assignees.find((x) => x.userId === me);
      if (!a) throw new Error('Attività non assegnata a te.');
      if (isAdmin() || !db.settings.approval) { a.progress = value; a.pending = null; commit(); return 'applied'; }
      a.pending = value === a.progress ? null : value;
      commit();
      return a.pending == null ? 'unchanged' : 'pending';
    },
    async setProgressFor(taskId, userId, value) {
      requireAdmin();
      const a = byId(db.tasks, taskId).assignees.find((x) => x.userId === userId);
      a.progress = value; a.pending = null; commit();
    },
    async decideProgress(taskId, userId, approve) {
      requireAdmin();
      const a = byId(db.tasks, taskId).assignees.find((x) => x.userId === userId);
      if (approve && a.pending != null) a.progress = a.pending;
      a.pending = null; commit();
    },
    async addComment(taskId, text) {
      byId(db.tasks, taskId).comments.push({ id: uid(), author: me, text, at: new Date().toISOString() });
      commit();
    },

    async saveMemo({ id, text, forDate, recipients }) {
      requireAdmin();
      let m = id ? byId(db.memos, id) : null;
      const before = m ? m.recipients.map((r) => r.userId) : [];
      const now = new Date().toISOString();
      if (m) Object.assign(m, { text, forDate: forDate || null, updatedAt: now });
      else {
        m = { id: uid(), author: me, text, forDate: forDate || null, createdAt: now, updatedAt: now, recipients: [] };
        db.memos.push(m);
      }
      // An edited memo shows up again as unread for everyone who receives it.
      m.recipients = recipients.map((userId) => ({ userId, read: false, done: false }));
      commit();
      return { memo: structuredClone(m), ...diffIds(before, recipients) };
    },
    async deleteMemo(id) { requireAdmin(); db.memos = db.memos.filter((m) => m.id !== id); commit(); },
    async markMemo(memoId, read, done) {
      const r = byId(db.memos, memoId)?.recipients.find((x) => x.userId === me);
      if (!r) throw new Error('Memo non tuo.');
      r.read = read; r.done = done; commit();
    },

    async notify(userIds, text, link) {
      const at = new Date().toISOString();
      userIds.filter((u) => u !== me && byId(db.profiles, u)).forEach((userId) => db.notifications.unshift({ id: uid(), userId, text, link, read: false, at }));
      commit();
    },
    async markNotificationsRead(ids) {
      db.notifications.forEach((n) => { if (n.userId === me && ids.includes(n.id)) n.read = true; });
      commit();
    },
    async log(text) {
      db.log.unshift({ at: new Date().toISOString(), by: user()?.name || '', text });
      db.log = db.log.slice(0, 300);
      commit();
    },
    async setApproval(on) {
      requireAdmin();
      db.settings.approval = on;
      if (!on) db.tasks.forEach((t) => t.assignees.forEach((a) => { if (a.pending != null) { a.progress = a.pending; a.pending = null; } }));
      commit();
    },

    async createUser({ name, email, role, job }) {
      requireAdmin();
      const palette = ['#12428a', '#3f6cb3', '#0e5f8a', '#4a4fb0', '#1f3b70', '#2c5aa0', '#0b4f6c'];
      const p = { id: uid(), name, email, role, job: job || '', color: palette[db.profiles.length % palette.length] };
      db.profiles.push(p);
      commit();
      return p;
    },
    async updateUser(id, patch) { requireAdmin(); Object.assign(byId(db.profiles, id), patch); commit(); },
    async resetPassword() { requireAdmin(); },
    async deleteUser(id) {
      requireAdmin();
      if (id === me) throw new Error('Non puoi togliere l’accesso a te stesso.');
      db.profiles = db.profiles.filter((p) => p.id !== id);
      db.tasks.forEach((t) => { t.assignees = t.assignees.filter((a) => a.userId !== id); });
      db.memos.forEach((m) => { m.recipients = m.recipients.filter((r) => r.userId !== id); });
      db.projects.forEach((p) => { p.members = p.members.filter((u) => u !== id); });
      db.notifications = db.notifications.filter((n) => n.userId !== id);
      commit();
    },

    pushSupported: false,
    async savePushSubscription() { /* no push in trial mode */ },
    async reset() { db = seed(); commit(); },
  };
}
