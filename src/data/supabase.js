// Real mode: data, accounts and live updates through Supabase. Access rules live in the database (supabase/schema.sql):
// this file never decides who may see what. Accounts and notifications go through the server functions in /api.
import { createClient } from '@supabase/supabase-js';

export function createSupabaseApi({ url, anonKey, vapidPublicKey }) {
  const sb = createClient(url, anonKey, { auth: { persistSession: true, autoRefreshToken: true } });
  let me = null;

  const check = ({ data, error }) => {
    if (error) throw new Error(translate(error.message));
    return data;
  };
  function translate(msg) {
    if (/Invalid login credentials/i.test(msg)) return 'Email o password non corretti.';
    if (/row-level security|permission denied/i.test(msg)) return 'Non hai il permesso per farlo.';
    if (/Password should be/i.test(msg)) return 'La password deve avere almeno 8 caratteri.';
    return msg;
  }
  async function token() {
    const { data } = await sb.auth.getSession();
    return data.session?.access_token || '';
  }
  async function callApi(path, method, body) {
    const res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || 'Operazione non riuscita, riprova.');
    return out;
  }
  async function profile(id) {
    return check(await sb.from('profiles').select('id,name,email,role,job,color').eq('id', id).maybeSingle());
  }
  const mapNote = (n) => ({ id: n.id, text: n.text, link: n.link, read: n.read, at: n.created_at });

  return {
    mode: 'supabase',
    async getUser() {
      const { data } = await sb.auth.getSession();
      if (!data.session) { me = null; return null; }
      me = await profile(data.session.user.id);
      return me;
    },
    async signIn(email, password) {
      const data = check(await sb.auth.signInWithPassword({ email, password }));
      me = await profile(data.user.id);
      if (!me) { await sb.auth.signOut(); throw new Error('Il tuo account non è ancora attivo: chiedi a un amministratore.'); }
      return me;
    },
    async signOut() { await sb.auth.signOut(); me = null; },
    async changePassword(password) { check(await sb.auth.updateUser({ password })); },
    onChange(cb) {
      let t;
      const ch = sb.channel('geco-team')
        .on('postgres_changes', { event: '*', schema: 'public' }, () => { clearTimeout(t); t = setTimeout(cb, 300); })
        .subscribe();
      return () => sb.removeChannel(ch);
    },

    async load() {
      const q = (table, cols = '*') => sb.from(table).select(cols);
      const [settings, profiles, projects, members, tasks, assignees, comments, memos, recipients, notes, log] = await Promise.all([
        q('settings', 'approval').eq('id', 1).maybeSingle(),
        q('profiles', 'id,name,email,role,job,color').order('name'),
        q('projects'),
        q('project_members'),
        q('tasks'),
        q('task_assignees'),
        q('comments').order('created_at'),
        q('memos'),
        q('memo_recipients'),
        q('notifications').eq('user_id', me.id).order('created_at', { ascending: false }).limit(60),
        me.role === 'admin' ? q('activity_log').order('created_at', { ascending: false }).limit(60) : Promise.resolve({ data: [] }),
      ]).then((rs) => rs.map(check));
      return {
        settings: { approval: settings ? settings.approval : true },
        profiles,
        projects: projects.map((p) => ({
          id: p.id, cat: p.cat, code: p.code, name: p.name, status: p.status, due: p.due,
          members: members.filter((m) => m.project_id === p.id).map((m) => m.user_id),
        })),
        tasks: tasks.map((t) => ({
          id: t.id, projectId: t.project_id, title: t.title, notes: t.notes, due: t.due, priority: t.priority, createdAt: t.created_at,
          assignees: assignees.filter((a) => a.task_id === t.id).map((a) => ({ userId: a.user_id, progress: a.progress, pending: a.pending })),
          comments: comments.filter((c) => c.task_id === t.id).map((c) => ({ id: c.id, author: c.author, text: c.text, at: c.created_at })),
        })),
        memos: memos.map((m) => ({
          id: m.id, author: m.author, text: m.text, forDate: m.for_date, createdAt: m.created_at, updatedAt: m.updated_at,
          recipients: recipients.filter((r) => r.memo_id === m.id).map((r) => ({ userId: r.user_id, read: r.read, done: r.done })),
        })),
        notifications: notes.map(mapNote),
        log: log.map((l) => ({ at: l.created_at, by: l.actor_name, text: l.text })),
      };
    },

    async saveProject({ id, cat, name, status, due, members }) {
      const row = id
        ? check(await sb.from('projects').update({ name, status, due: due || null }).eq('id', id).select().single())
        : check(await sb.from('projects').insert({ cat, name, status, due: due || null, created_by: me.id }).select().single());
      const current = check(await sb.from('project_members').select('user_id').eq('project_id', row.id)).map((r) => r.user_id);
      const taskIds = check(await sb.from('tasks').select('id').eq('project_id', row.id)).map((r) => r.id);
      const assignees = taskIds.length ? check(await sb.from('task_assignees').select('user_id').in('task_id', taskIds)).map((r) => r.user_id) : [];
      const wanted = [...new Set([...members, ...assignees])];
      const added = wanted.filter((u) => !current.includes(u));
      const removed = current.filter((u) => !wanted.includes(u));
      if (removed.length) check(await sb.from('project_members').delete().eq('project_id', row.id).in('user_id', removed));
      if (added.length) check(await sb.from('project_members').insert(added.map((user_id) => ({ project_id: row.id, user_id }))));
      return { project: { id: row.id, code: row.code, name: row.name, cat: row.cat }, added, removed };
    },
    async deleteProject(id) { check(await sb.from('projects').delete().eq('id', id)); },
    async setProjectStatus(id, status) { check(await sb.from('projects').update({ status }).eq('id', id)); },

    async saveTask({ id, projectId, title, notes, due, priority, assignees }) {
      const fields = { project_id: projectId, title, notes, due: due || null, priority };
      const row = id
        ? check(await sb.from('tasks').update(fields).eq('id', id).select().single())
        : check(await sb.from('tasks').insert({ ...fields, created_by: me.id }).select().single());
      const current = id ? check(await sb.from('task_assignees').select('user_id').eq('task_id', row.id)).map((r) => r.user_id) : [];
      const added = assignees.filter((u) => !current.includes(u));
      const removed = current.filter((u) => !assignees.includes(u));
      if (removed.length) check(await sb.from('task_assignees').delete().eq('task_id', row.id).in('user_id', removed));
      if (added.length) check(await sb.from('task_assignees').insert(added.map((user_id) => ({ task_id: row.id, user_id }))));
      return { task: { id: row.id, title: row.title, due: row.due, projectId: row.project_id }, added, removed };
    },
    async deleteTask(id) { check(await sb.from('tasks').delete().eq('id', id)); },

    async setMyProgress(taskId, value) { return check(await sb.rpc('set_my_progress', { p_task: taskId, p_value: value })); },
    async setProgressFor(taskId, userId, value) {
      check(await sb.from('task_assignees').update({ progress: value, pending: null }).eq('task_id', taskId).eq('user_id', userId));
    },
    async decideProgress(taskId, userId, approve) { check(await sb.rpc('decide_progress', { p_task: taskId, p_user: userId, p_approve: approve })); },
    async addComment(taskId, text) { check(await sb.from('comments').insert({ task_id: taskId, author: me.id, text })); },

    async saveMemo({ id, text, forDate, recipients }) {
      const row = id
        ? check(await sb.from('memos').update({ text, for_date: forDate || null }).eq('id', id).select().single())
        : check(await sb.from('memos').insert({ text, for_date: forDate || null, author: me.id }).select().single());
      const current = id ? check(await sb.from('memo_recipients').select('user_id').eq('memo_id', row.id)).map((r) => r.user_id) : [];
      const removed = current.filter((u) => !recipients.includes(u));
      if (removed.length) check(await sb.from('memo_recipients').delete().eq('memo_id', row.id).in('user_id', removed));
      // An edited memo shows up again as unread for everyone who receives it.
      if (recipients.length) {
        check(await sb.from('memo_recipients').upsert(recipients.map((user_id) => ({ memo_id: row.id, user_id, read: false, done: false }))));
      }
      return { memo: { id: row.id }, added: recipients.filter((u) => !current.includes(u)), removed };
    },
    async deleteMemo(id) { check(await sb.from('memos').delete().eq('id', id)); },
    async markMemo(memoId, read, done) { check(await sb.rpc('mark_memo', { p_memo: memoId, p_read: read, p_done: done })); },

    async notify(userIds, text, link) {
      const targets = userIds.filter((u) => u !== me.id);
      if (!targets.length) return;
      const ids = check(await sb.rpc('notify', { p_users: targets, p_text: text, p_link: link || '' }));
      // Phone push and email are sent by the server; a failure there must not block the action itself.
      if (ids && ids.length) callApi('/api/notify', 'POST', { ids: ids.map((r) => (typeof r === 'string' ? r : r.notify || r.id)) }).catch(() => {});
    },
    async markNotificationsRead(ids) {
      if (ids.length) check(await sb.from('notifications').update({ read: true }).in('id', ids));
    },
    async log(text) { await sb.from('activity_log').insert({ actor: me.id, actor_name: me.name, text }); },
    async setApproval(on) { check(await sb.rpc('set_approval', { p_on: on })); },

    async createUser(data) { return (await callApi('/api/users', 'POST', data)).profile; },
    async updateUser(id, patch) { check(await sb.from('profiles').update(patch).eq('id', id)); },
    async resetPassword(id, password) { await callApi('/api/users', 'PATCH', { id, password }); },
    async deleteUser(id) { await callApi('/api/users', 'DELETE', { id }); },
    async downloadBackup() { return callApi('/api/backup', 'GET'); },

    pushSupported: !!vapidPublicKey && 'serviceWorker' in navigator && 'PushManager' in window,
    vapidPublicKey,
    async savePushSubscription(sub) {
      const j = sub.toJSON();
      check(await sb.from('push_subscriptions').upsert({ user_id: me.id, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }, { onConflict: 'endpoint' }));
    },
  };
}
