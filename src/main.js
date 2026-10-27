// Geco Team: the app. Two kinds of people: administrators (see and change everything, decide who sees each project)
// and team members (own tasks, own memos, projects opened to them). Data comes from src/data/* (Supabase in real mode,
// this browser in trial mode); this file only draws screens and calls that API.
import './styles.css';
import {
  CATS, PSTATUS, PRIO, byId, category, pstatus, prio, addDays, daysFromToday, fmtDate, fmtAgo, assigneeOf, taskAvg, avg,
  isLate, status, byUrgency, nextCode, esc, short, EMAIL_RE,
} from './logic.js';
import { createLocalApi } from './data/local.js';
import { createSupabaseApi } from './data/supabase.js';

const env = import.meta.env;
const api = env.VITE_SUPABASE_URL && env.VITE_SUPABASE_ANON_KEY
  ? createSupabaseApi({ url: env.VITE_SUPABASE_URL, anonKey: env.VITE_SUPABASE_ANON_KEY, vapidPublicKey: env.VITE_VAPID_PUBLIC_KEY })
  : createLocalApi();
const TRIAL = api.mode === 'local';

const app = document.getElementById('app');
const modal = document.querySelector('[data-modal]');
const modalForm = document.querySelector('[data-modal-form]');
const toastEl = document.querySelector('[data-toast]');
const phoneEl = document.querySelector('[data-phone]');

let me = null;
let snap = null;
let bellOpen = false;
let busy = false;
let refreshWaiting = false;
const openComments = {};

// ---------- small helpers ----------
const isAdmin = () => me?.role === 'admin';
const person = (id) => byId(snap.profiles, id);
const nameOf = (id) => person(id)?.name || 'Ex membro';
const members = () => snap.profiles.filter((p) => p.role === 'member');
const admins = () => snap.profiles.filter((p) => p.role === 'admin');
const project = (id) => byId(snap.projects, id);
const homeHash = () => (isAdmin() ? '#/team' : '#/io');
const isArchived = (t) => project(t.projectId)?.status === 'chiuso';
const liveTasks = () => snap.tasks.filter((t) => !isArchived(t));
const progressOf = (t, uid) => assigneeOf(t, uid)?.progress ?? 0;
const tasksOf = (uid) => liveTasks().filter((t) => assigneeOf(t, uid)).sort(byUrgency((t) => progressOf(t, uid)));
const memosOf = (uid) => snap.memos.filter((m) => m.recipients.some((r) => r.userId === uid)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
const myRecipient = (m) => m.recipients.find((r) => r.userId === me.id);
const pendingRows = () => liveTasks().flatMap((t) => t.assignees.filter((a) => a.pending != null).map((a) => ({ t, a })));
const personAvg = (uid) => avg(tasksOf(uid).map((t) => progressOf(t, uid)));
const lateFor = (uid) => tasksOf(uid).filter((t) => isLate(t.due, progressOf(t, uid))).length;

function initials(name) { return name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase(); }
function avatar(p, size = '') {
  if (!p) return '';
  return `<span class="avatar${size ? ` avatar-${size}` : ''}" style="--c:${esc(p.color)}" title="${esc(p.name)}" aria-hidden="true">${esc(initials(p.name))}</span>`;
}
function bar(pct, cls = '') {
  return `<span class="bar ${cls}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Avanzamento ${pct}%"><i style="width:${pct}%"></i></span>`;
}
const prioBadge = (t) => `<span class="prio prio-${t.priority}">${prio(t.priority).label}</span>`;
const names = (ids) => ids.map(nameOf).join(', ');

function toast(text, isError = false) {
  toastEl.textContent = text;
  toastEl.classList.toggle('toast-error', isError);
  toastEl.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { toastEl.hidden = true; }, isError ? 5000 : 3200);
}

// Trial mode shows what the phone would receive; in real mode the server sends it for real.
function phonePreview(userIds, text) {
  if (!TRIAL || !userIds.length) return;
  phoneEl.innerHTML = `<span class="ph-app"><img src="/img/favicon.svg" alt="" width="18" height="18"> Geco Team · ora</span><strong>${esc(text)}</strong><span class="ph-who">Notifica sul telefono di ${esc(names(userIds))} (prova)</span>`;
  phoneEl.hidden = false;
  clearTimeout(phonePreview.t);
  phonePreview.t = setTimeout(() => { phoneEl.hidden = true; }, 5000);
}
async function notify(userIds, text, link) {
  const to = [...new Set(userIds)].filter((u) => u && u !== me.id);
  if (!to.length) return;
  await api.notify(to, text, link);
  phonePreview(to, text);
}
const notifyAdmins = (text, link) => notify(admins().map((a) => a.id), text, link);

// Every action: run it, record it, reload, report. Errors are shown, never swallowed.
async function act(fn, okText) {
  if (busy) return;
  busy = true;
  try {
    await fn();
    await refresh(true);
    if (okText) toast(okText);
  } catch (e) {
    toast(e.message || 'Qualcosa non ha funzionato, riprova.', true);
    await refresh(true).catch(() => {});
  } finally {
    busy = false;
  }
}
const log = (text) => api.log(text).catch(() => {});

// ---------- layout ----------
function shell(main, active) {
  const adm = isAdmin();
  const tabs = adm
    ? [['#/team', 'Team', 'team'], ['#/progetti', 'Progetti', 'progetti'], ['#/scadenze', 'Scadenze', 'scadenze'], ['#/memo', 'Memo', 'memo'], ['#/persone', 'Persone', 'persone'], ['#/report', 'Report', 'report']]
    : [['#/io', 'Le mie attività', 'io'], ['#/progetti', 'Progetti', 'progetti'], ['#/scadenze', 'Scadenze', 'scadenze']];
  const notes = snap.notifications;
  const unread = notes.filter((n) => !n.read).length;
  const nav = tabs.map(([href, label, id]) => `<a href="${href}"${active === id ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  return `
    ${TRIAL ? `<div class="demo-bar" role="note"><span><strong>Modalità prova</strong>: i dati restano solo su questo dispositivo.</span><button type="button" class="link-btn" data-action="reset">Svuota tutto</button></div>` : ''}
    <header class="top">
      <div class="wrap top-in">
        <a class="logo" href="${homeHash()}" aria-label="Schermata principale"><img src="/img/logo-bianco.webp" alt="Geco Corporate" width="520" height="267"><span>Area team</span></a>
        <nav class="tabs" aria-label="Sezioni">${nav}</nav>
        <div class="who">
          <div class="bell-wrap">
            <button type="button" class="bell" data-action="bell" aria-expanded="${bellOpen}" aria-label="Notifiche${unread ? `, ${unread} nuove` : ''}">
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3a1.5 1.5 0 0 0-3 0v1.16A7 7 0 0 0 5 11v5l-2 2v1h18v-1Z" fill="currentColor"/></svg>
              ${unread ? `<span class="bell-n">${unread}</span>` : ''}
            </button>
            ${bellOpen ? bellPanel(notes) : ''}
          </div>
          <button type="button" class="me-btn" data-action="account" aria-label="Il tuo account">${avatar(me, 'sm')}<span class="who-name">${esc(me.name)}${isAdmin() ? ' <em>amministratore</em>' : ''}</span></button>
        </div>
      </div>
    </header>
    <nav class="bottom-nav" aria-label="Sezioni">${nav}</nav>
    <main class="wrap main" id="main">${pushBanner()}${main}</main>`;
}

function bellPanel(notes) {
  return `
    <div class="bell-panel" role="dialog" aria-label="Notifiche">
      <div class="bp-head"><strong>Notifiche</strong>${notes.some((n) => !n.read) ? '<button type="button" class="link-btn" data-action="notes-read">Segna tutte come lette</button>' : ''}</div>
      ${notes.length ? `<ul>${notes.slice(0, 30).map((n) => `<li><button type="button" class="bp-item${n.read ? '' : ' unread'}" data-action="open-note" data-id="${n.id}"><span>${esc(n.text)}</span><small>${esc(fmtAgo(n.at))}</small></button></li>`).join('')}</ul>` : '<p class="empty">Nessuna notifica.</p>'}
      ${pushState() === 'off' ? '<p class="bp-foot"><button type="button" class="link-btn" data-action="push-on">Ricevile anche sul telefono</button></p>' : ''}
    </div>`;
}

// ---------- phone notifications (Web Push) ----------
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
function pushState() {
  if (TRIAL || !api.pushSupported) return isIos() && !standalone() && !TRIAL ? 'ios-install' : 'none';
  if (!('Notification' in window)) return 'none';
  if (Notification.permission === 'denied') return 'denied';
  return localStorage.getItem(`geco-push-${me.id}`) === 'on' && Notification.permission === 'granted' ? 'on' : 'off';
}
function pushBanner() {
  const s = pushState();
  if (s === 'off') return `<div class="banner"><span><strong>Attiva le notifiche</strong> per sapere subito di memo, attività e scadenze.</span><button type="button" class="btn btn-primary btn-sm" data-action="push-on">Attiva</button></div>`;
  if (s === 'ios-install') return `<div class="banner"><span>Per ricevere le notifiche su iPhone: tocca <strong>Condividi</strong> e poi <strong>Aggiungi alla schermata Home</strong>, poi apri l’app da lì.</span></div>`;
  if (s === 'denied') return `<div class="banner"><span>Le notifiche sono bloccate: riattivale nelle impostazioni del browser per questo sito.</span></div>`;
  return '';
}
function urlB64ToUint8(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { toast('Notifiche non attivate.', true); render(); return; }
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription())
    || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(api.vapidPublicKey) }));
  await api.savePushSubscription(sub);
  localStorage.setItem(`geco-push-${me.id}`, 'on');
  render();
  toast('Notifiche attivate su questo dispositivo.');
}

// ---------- shared pieces ----------
// Progress controls are buttons, never sliders: on a phone a slider changes value while you scroll the page.
function progressControls(t, a) {
  const shown = !isAdmin() && a.pending != null ? a.pending : a.progress;
  return `
    <div class="steps" role="group" aria-label="Avanzamento di ${esc(nameOf(a.userId))}">
      <button type="button" class="step-btn" data-action="progress" data-task="${t.id}" data-user="${a.userId}" data-v="${Math.max(0, shown - 5)}" aria-label="Meno 5%">−</button>
      ${[0, 25, 50, 75, 100].map((v) => `<button type="button" class="chip${shown === v ? ' on' : ''}" data-action="progress" data-task="${t.id}" data-user="${a.userId}" data-v="${v}">${v === 100 ? 'Fatto ✓' : `${v}%`}</button>`).join('')}
      <button type="button" class="step-btn" data-action="progress" data-task="${t.id}" data-user="${a.userId}" data-v="${Math.min(100, shown + 5)}" aria-label="Più 5%">+</button>
    </div>`;
}

function assigneeLine(t, a) {
  const st = status(t.due, a.progress);
  const mine = a.userId === me.id;
  const shown = !isAdmin() && mine && a.pending != null ? a.pending : a.progress;
  const canChange = isAdmin() || mine;
  const multi = t.assignees.length > 1;
  return `
    <div class="as-line${mine ? ' is-mine' : ''}">
      <div class="as-head">
        ${multi || isAdmin() ? `<span class="as-name">${avatar(person(a.userId), 'xs')}${esc(nameOf(a.userId))}${mine ? ' (tu)' : ''}</span>` : ''}
        ${bar(shown, `bar-lg ${st.cls}`)}
        <strong class="task-pct">${shown}%</strong>
      </div>
      ${a.pending != null && isAdmin() ? `<div class="pending"><span><strong>${esc(nameOf(a.userId))}</strong> propone <strong>${a.pending}%</strong> (ora ${a.progress}%)</span><span class="pending-btns"><button type="button" class="btn btn-primary btn-sm" data-action="approve" data-task="${t.id}" data-user="${a.userId}">Approva</button><button type="button" class="btn btn-ghost btn-sm" data-action="reject" data-task="${t.id}" data-user="${a.userId}">Rifiuta</button></span></div>` : ''}
      ${a.pending != null && mine && !isAdmin() ? `<p class="pending-note">Hai proposto ${a.pending}%: in attesa che un amministratore approvi (ora risulta ${a.progress}%).</p>` : ''}
      ${canChange ? progressControls(t, a) : ''}
    </div>`;
}

function taskRow(t, opts = {}) {
  const pr = project(t.projectId);
  const focusUser = opts.forUser;
  const pct = focusUser ? progressOf(t, focusUser) : taskAvg(t);
  const st = status(t.due, pct);
  const lines = opts.onlyUser ? t.assignees.filter((a) => a.userId === opts.onlyUser) : t.assignees;
  const open = !!openComments[t.id];
  return `
    <li class="task prio-edge-${t.priority}" data-task-id="${t.id}">
      <div class="task-top">
        <div class="task-info">
          <strong class="task-title">${esc(t.title)}</strong>
          <span class="task-meta">${pr ? `<span class="code">${esc(pr.code)}</span> ${esc(pr.name)} · ` : ''}scadenza ${esc(fmtDate(t.due))}${t.assignees.length > 1 ? ` · ${t.assignees.length} persone` : ''}</span>
        </div>
        <span class="badges">${prioBadge(t)}<span class="badge ${st.cls}">${st.label}</span></span>
      </div>
      ${t.notes ? `<p class="task-notes">${esc(t.notes)}</p>` : ''}
      <div class="as-lines">${lines.map((a) => assigneeLine(t, a)).join('')}</div>
      ${opts.onlyUser && t.assignees.length > 1 ? `<p class="muted small">Con ${esc(names(t.assignees.map((a) => a.userId).filter((u) => u !== opts.onlyUser)))} · media ${taskAvg(t)}%</p>` : ''}
      <div class="task-tools">
        <button type="button" class="link-btn" data-action="toggle-comments" data-id="${t.id}" aria-expanded="${open}">Commenti${t.comments.length ? ` (${t.comments.length})` : ''}</button>
        ${isAdmin() ? `<button type="button" class="link-btn" data-action="edit-task" data-id="${t.id}">Modifica</button><button type="button" class="link-btn danger" data-action="delete-task" data-id="${t.id}">Elimina</button>` : ''}
      </div>
      ${open ? commentBox(t) : ''}
    </li>`;
}

function commentBox(t) {
  return `
    <div class="comments">
      ${t.comments.length ? `<ul>${t.comments.map((c) => `<li class="cm${c.author === me.id ? ' cm-me' : ''}"><span class="cm-who">${esc(nameOf(c.author))} · ${esc(fmtAgo(c.at))}</span><p>${esc(c.text)}</p></li>`).join('')}</ul>` : '<p class="empty small">Ancora nessun commento.</p>'}
      <form class="cm-form" data-comment="${t.id}"><label class="sr-only" for="cm-${t.id}">Scrivi un commento</label>
        <input id="cm-${t.id}" name="text" maxlength="800" placeholder="Scrivi un commento…" autocomplete="off"><button class="btn btn-primary btn-sm" type="submit">Invia</button></form>
    </div>`;
}

function memoItem(m, opts = {}) {
  const r = myRecipient(m);
  const edited = m.updatedAt && m.createdAt && Date.parse(m.updatedAt) - Date.parse(m.createdAt) > 60000;
  let state = '';
  if (opts.employee && r) state = r.done ? '<span class="badge ok">Fatto</span>' : r.read ? '<span class="badge run">Letto</span>' : '<span class="badge new">Nuovo</span>';
  const readers = m.recipients.map((x) => `<span class="rcp ${x.done ? 'ok' : x.read ? 'read' : ''}" title="${x.done ? 'Fatto' : x.read ? 'Letto' : 'Non ancora letto'}">${esc(nameOf(x.userId))}${x.done ? ' ✓' : x.read ? ' · letto' : ''}</span>`).join('');
  return `
    <li class="memo${opts.employee && r && !r.read ? ' unread' : ''}${opts.employee && r?.done ? ' done' : ''}">
      <div class="memo-head"><span class="memo-for">Per ${esc(fmtDate(m.forDate))} · da ${esc(nameOf(m.author))}${edited ? ' · modificato' : ''}</span>${state}</div>
      <p class="memo-text">${esc(m.text)}</p>
      ${opts.employee
        ? `<div class="memo-actions">${!r.read ? `<button type="button" class="btn btn-soft btn-sm" data-action="memo-read" data-id="${m.id}">Ho letto</button>` : ''}${r.done ? `<button type="button" class="link-btn" data-action="memo-undo" data-id="${m.id}">Segna come da fare</button>` : `<button type="button" class="btn btn-primary btn-sm" data-action="memo-done" data-id="${m.id}">Fatto ✓</button>`}</div>`
        : `<div class="rcps">${readers}</div><div class="memo-actions"><button type="button" class="link-btn" data-action="edit-memo" data-id="${m.id}">Modifica</button><button type="button" class="link-btn danger" data-action="delete-memo" data-id="${m.id}">Elimina</button></div>`}
    </li>`;
}

function membersLine(pr) {
  const list = pr.members.map(person).filter((p) => p && p.role === 'member');
  return `<div class="proj-people"><span class="muted small">Lo vedono:</span>${list.length ? `${list.map((p) => avatar(p, 'sm')).join('')}<span class="small names">${esc(list.map((p) => p.name).join(', '))}</span>` : '<span class="muted small">solo gli amministratori</span>'}</div>`;
}

function emptyState(title, text, button) {
  return `<div class="card empty-state"><h2>${title}</h2><p class="muted">${text}</p>${button || ''}</div>`;
}

// ---------- views ----------
function viewLogin(profiles) {
  if (TRIAL) {
    return `
      <div class="demo-bar" role="note"><span><strong>Modalità prova</strong>: scegli con chi entrare. Nella versione vera ognuno entra con email e password.</span></div>
      <main class="login wrap">
        <img class="login-logo" src="/img/logo.webp" alt="Geco Corporate" width="520" height="267">
        <h1>Area team</h1>
        <div class="login-grid">
          ${profiles.map((p) => `<button type="button" class="login-card${p.role === 'admin' ? ' owner-card' : ''}" data-action="login-as" data-id="${p.id}">${avatar(p, 'lg')}<strong>${esc(p.name)}</strong><span>${p.role === 'admin' ? 'Amministratore' : esc(p.job || 'Team')}</span></button>`).join('')}
        </div>
      </main>`;
  }
  return `
    <main class="login wrap">
      <img class="login-logo" src="/img/logo.webp" alt="Geco Corporate" width="520" height="267">
      <h1>Area team</h1>
      <form class="card login-form" data-login novalidate>
        <div class="field"><label for="l-email">Email</label><input id="l-email" name="email" type="email" autocomplete="username" required></div>
        <div class="field"><label for="l-pw">Password</label><input id="l-pw" name="password" type="password" autocomplete="current-password" required></div>
        <p class="form-error" data-err hidden></p>
        <button class="btn btn-primary btn-block" type="submit">Entra</button>
        <p class="muted small">Password dimenticata? Chiedi a Giorgio o Fortunato di reimpostarla.</p>
      </form>
    </main>`;
}

function teamCards() {
  return members().map((p) => {
    const list = tasksOf(p.id);
    const open = list.filter((t) => progressOf(t, p.id) < 100).length;
    const late = lateFor(p.id);
    const pct = personAvg(p.id);
    return `
      <article class="card person-card">
        <header class="pc-head">${avatar(p)}<div><h2><a href="#/persona/${p.id}">${esc(p.name)}</a></h2><p class="muted">${esc(p.job || 'Team')}</p></div><strong class="pc-pct">${pct}%</strong></header>
        ${bar(pct, 'bar-lg')}
        <p class="pc-meta">${open} aperte su ${list.length}${late ? ` · <span class="txt-late">${late} in ritardo</span>` : ''}</p>
        <ul class="mini-tasks">${list.slice(0, 3).map((t) => {
          const v = progressOf(t, p.id);
          const st = status(t.due, v);
          return `<li><span class="mt-title">${t.priority === 'alta' && v < 100 ? '<span class="dot-high" title="Priorità alta"></span>' : ''}${esc(t.title)}</span><span class="mt-pct ${st.cls}">${v}%</span>${bar(v, `bar-sm ${st.cls}`)}</li>`;
        }).join('')}</ul>
        <footer class="pc-actions"><a class="btn btn-soft" href="#/persona/${p.id}">Apri la scheda</a><button type="button" class="btn btn-soft" data-action="new-memo" data-person="${p.id}">Scrivi memo</button></footer>
      </article>`;
  }).join('');
}

function viewTeam() {
  const live = liveTasks();
  const allRows = live.flatMap((t) => t.assignees.map((a) => ({ t, a })));
  const open = live.filter((t) => taskAvg(t) < 100).length;
  const late = allRows.filter(({ t, a }) => isLate(t.due, a.progress)).length;
  const pend = pendingRows();
  const kpi = (n, label, cls, href) => `<a class="kpi ${cls || ''}" href="${href}"><strong>${n}</strong><span>${label}</span></a>`;
  const noProjects = !snap.projects.length;
  return shell(`
    <div class="page-head">
      <div><p class="eyebrow">${esc(new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' }))}</p><h1>Il team</h1></div>
      <div class="head-actions"><button type="button" class="btn btn-ghost" data-action="new-memo">Scrivi un memo</button><button type="button" class="btn btn-primary" data-action="new-task">+ Nuova attività</button></div>
    </div>
    ${noProjects ? emptyState('Si comincia da qui', 'Crea il primo progetto: scegli la tipologia, la consegna e chi lo vede. Poi aggiungi le attività e assegnale a una o più persone.', '<button type="button" class="btn btn-primary" data-action="new-project">+ Crea il primo progetto</button>') : ''}
    <div class="kpis">
      ${kpi(open, 'attività in corso', '', '#/progetti')}
      ${kpi(`${avg(allRows.map(({ a }) => a.progress))}%`, 'avanzamento medio', '', '#/report')}
      ${kpi(late, 'in ritardo', late ? 'late' : '', '#/scadenze')}
      ${kpi(pend.length, 'da approvare', pend.length ? 'warn' : '', '#/team')}
    </div>
    ${pend.length ? `<section class="card approvals"><div class="sec-head"><h2>Da approvare <span class="count">${pend.length}</span></h2></div><ul class="tasks">${[...new Set(pend.map(({ t }) => t))].map((t) => taskRow(t)).join('')}</ul></section>` : ''}
    <section class="people-grid" aria-label="Persone del team">${teamCards()}</section>`, 'team');
}

function viewPerson(uid) {
  const p = person(uid);
  if (!p) return viewTeam();
  const list = tasksOf(uid);
  const memos = memosOf(uid);
  const seen = snap.projects.filter((pr) => pr.status !== 'chiuso' && pr.members.includes(uid));
  const pct = personAvg(uid);
  return shell(`
    <a class="back" href="#/team">← Torna al team</a>
    <div class="person-head card">${avatar(p, 'lg')}
      <div class="ph-text"><h1>${esc(p.name)}</h1><p class="muted">${esc(p.job || 'Team')} · vede ${seen.length ? esc(seen.map((x) => x.code).join(', ')) : 'nessun progetto'}</p></div>
      <div class="ph-pct"><strong>${pct}%</strong><span>avanzamento medio</span>${bar(pct, 'bar-lg')}</div>
    </div>
    <div class="two-col">
      <section class="card">
        <div class="sec-head"><h2>Attività <span class="count">${list.length}</span></h2><button type="button" class="btn btn-primary btn-sm" data-action="new-task" data-person="${uid}">+ Assegna</button></div>
        ${list.length ? `<ul class="tasks">${list.map((t) => taskRow(t, { forUser: uid })).join('')}</ul>` : '<p class="empty">Nessuna attività assegnata.</p>'}
      </section>
      <section class="card folder">
        <div class="sec-head"><h2>Memo</h2><button type="button" class="btn btn-primary btn-sm" data-action="new-memo" data-person="${uid}">+ Scrivi</button></div>
        ${memos.length ? `<ul class="memos">${memos.map((m) => memoItem(m)).join('')}</ul>` : '<p class="empty">Ancora nessun memo.</p>'}
      </section>
    </div>`, 'team');
}

function viewProjects(filter) {
  const adm = isAdmin();
  const archive = filter === 'archivio';
  const visible = snap.projects;
  const active = visible.filter((p) => p.status !== 'chiuso');
  const shown = visible.filter((p) => (archive ? p.status === 'chiuso' : p.status !== 'chiuso' && (!filter || p.cat === filter)))
    .sort((a, b) => (a.code < b.code ? -1 : 1));
  const chips = [['', 'Tutti', active.length], ...CATS.map((c) => [c.id, c.label, active.filter((p) => p.cat === c.id).length])]
    .concat(adm ? [['archivio', 'Archivio', visible.length - active.length]] : []);
  const cards = shown.map((pr) => {
    const list = snap.tasks.filter((t) => t.projectId === pr.id).sort(byUrgency());
    const pct = avg(list.map(taskAvg));
    const dueN = pr.due ? daysFromToday(pr.due) : null;
    return `
      <article class="card project st-${pr.status}">
        <div class="proj-head"><div><span class="brand-tag">${esc(pr.code)}</span> <span class="cat-name">${esc(category(pr.cat).label)}</span><h2>${esc(pr.name)}</h2></div><strong class="pc-pct">${pct}%</strong></div>
        ${bar(pct, 'bar-lg')}
        <div class="proj-meta"><span class="pill ps-${pr.status}">${esc(pstatus(pr.status).label)}</span><span class="proj-due${pr.status !== 'chiuso' && dueN != null && dueN < 0 ? ' txt-late' : ''}">Consegna: ${esc(pr.due ? fmtDate(pr.due) : 'da definire')}</span></div>
        ${membersLine(pr)}
        ${list.length ? `<ul class="proj-tasks">${list.map((t) => {
          const v = taskAvg(t);
          const mine = !!assigneeOf(t, me.id);
          return `<li${mine ? ' class="is-mine"' : ''}><span>${esc(t.title)}<em> · ${esc(names(t.assignees.map((a) => a.userId)))}</em></span><span class="mt-pct ${status(t.due, v).cls}">${v}%</span></li>`;
        }).join('')}</ul>` : '<p class="empty">Ancora nessuna attività.</p>'}
        ${adm ? `<div class="proj-actions"><button type="button" class="btn btn-soft btn-sm" data-action="edit-project" data-id="${pr.id}">Modifica progetto</button>${archive ? '' : `<button type="button" class="btn btn-soft btn-sm" data-action="new-task" data-project="${pr.id}">+ Attività</button>`}</div>` : ''}
      </article>`;
  }).join('');
  let body;
  if (shown.length) body = `<section class="projects-grid">${cards}</section>`;
  else if (!visible.length && adm) body = emptyState('Nessun progetto', 'Crea il primo progetto: il codice (PRIV-001, PUB-001, GARA-001) viene assegnato da solo.', '<button type="button" class="btn btn-primary" data-action="new-project">+ Nuovo progetto</button>');
  else if (!visible.length) body = emptyState('Nessun progetto per ora', 'Quando un amministratore ti aprirà un progetto o ti assegnerà un’attività, lo vedrai qui.');
  else body = '<p class="empty">Nessun progetto qui.</p>';
  return shell(`
    <div class="page-head"><div><p class="eyebrow">${archive ? 'Progetti chiusi' : adm ? 'Avanzamento per progetto' : 'I progetti aperti per te'}</p><h1>${archive ? 'Archivio' : 'Progetti'}</h1></div>
    ${adm ? '<div class="head-actions"><button type="button" class="btn btn-primary" data-action="new-project">+ Nuovo progetto</button></div>' : ''}</div>
    ${visible.length ? `<div class="cat-filter" role="group" aria-label="Filtra">${chips.map(([id, label, n]) => `<a class="chip${(filter || '') === id ? ' on' : ''}" href="#/progetti${id ? `/${id}` : ''}">${label} <span>${n}</span></a>`).join('')}</div>` : ''}
    ${body}`, 'progetti');
}

function dlItem(t, a, opts = {}) {
  const pr = project(t.projectId);
  const n = daysFromToday(t.due);
  const cls = n < 0 ? 'late' : n <= 1 ? 'today' : '';
  return `<li class="dl-item${a.userId === me.id ? ' is-mine' : ''}"><span class="dl-date ${cls}"><strong>${esc(fmtDate(t.due))}</strong>${n < -1 ? `<small>${-n} giorni fa</small>` : ''}</span>
    <span class="dl-main"><strong>${esc(t.title)}</strong><small>${pr && !opts.byProject ? `${esc(pr.code)} · ` : ''}${esc(nameOf(a.userId))} · ${a.progress}%</small></span>${prioBadge(t)}
    ${isAdmin() ? `<a class="link-btn" href="#/persona/${a.userId}">Apri</a>` : ''}</li>`;
}

function viewDeadlines(mode) {
  const adm = isAdmin();
  const byProject = mode === 'progetti';
  const rows = liveTasks().flatMap((t) => t.assignees.filter((a) => a.progress < 100 && t.due && (adm || a.userId === me.id)).map((a) => ({ t, a })));
  const sortRows = (x, y) => (x.t.due < y.t.due ? -1 : x.t.due > y.t.due ? 1 : 0);
  let body;
  if (byProject) {
    const projs = snap.projects.filter((p) => p.status !== 'chiuso').sort((a, b) => ((a.due || '9999') < (b.due || '9999') ? -1 : 1));
    body = projs.map((pr) => {
      const items = liveTasks().filter((t) => t.projectId === pr.id).flatMap((t) => t.assignees.filter((a) => a.progress < 100).map((a) => ({ t, a }))).sort(sortRows);
      const people = [...new Set(items.map(({ a }) => a.userId))];
      const n = pr.due ? daysFromToday(pr.due) : null;
      return `<section class="card dl-project">
        <div class="dlp-head"><div><span class="brand-tag">${esc(pr.code)}</span><h2>${esc(pr.name)}</h2></div><span class="dl-date${n != null && n < 0 ? ' late' : n != null && n <= 7 ? ' today' : ''}"><small>Consegna</small><strong>${esc(pr.due ? fmtDate(pr.due) : 'da definire')}</strong></span></div>
        <div class="proj-people">${people.map((id) => avatar(person(id), 'sm')).join('')}<span class="muted small">${people.length ? esc(names(people)) + ' · ' : ''}${items.length} ${items.length === 1 ? 'attività aperta' : 'attività aperte'}</span></div>
        ${items.length ? `<ul class="dl-list">${items.map(({ t, a }) => dlItem(t, a, { byProject: true })).join('')}</ul>` : '<p class="empty small">Nessuna attività aperta.</p>'}
      </section>`;
    }).join('') || '<p class="empty">Nessun progetto aperto.</p>';
    body = `<div class="dl-projects">${body}</div>`;
  } else {
    const groups = [
      ['In ritardo', 'late', (n) => n < 0], ['Oggi e domani', 'today', (n) => n === 0 || n === 1],
      ['Questa settimana', '', (n) => n >= 2 && n <= 7], ['Più avanti', '', (n) => n > 7],
    ];
    const html = groups.map(([title, cls, test]) => {
      const items = rows.filter(({ t }) => test(daysFromToday(t.due))).sort(sortRows);
      return items.length ? `<section class="dl-group"><h2 class="dl-title ${cls}">${title} <span class="count">${items.length}</span></h2><ul class="dl-list">${items.map(({ t, a }) => dlItem(t, a)).join('')}</ul></section>` : '';
    }).join('');
    body = `<div class="card">${html || '<p class="empty">Nessuna scadenza aperta.</p>'}</div>`;
  }
  return shell(`
    <div class="page-head"><div><p class="eyebrow">${adm ? 'Tutto il team' : 'Le tue scadenze'}</p><h1>Scadenze</h1></div></div>
    <div class="cat-filter" role="group" aria-label="Raggruppa"><a class="chip${byProject ? '' : ' on'}" href="#/scadenze">Per data</a><a class="chip${byProject ? ' on' : ''}" href="#/scadenze/progetti">Per progetto</a></div>
    <p class="hint">${byProject ? 'Per ogni progetto: chi ci lavora e cosa scade, in ordine di data.' : 'Il giorno prima di una scadenza arriva un promemoria sul telefono.'}</p>
    ${body}`, 'scadenze');
}

function viewMemos() {
  const all = snap.memos.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return shell(`
    <div class="page-head"><div><p class="eyebrow">Tutti i memo inviati</p><h1>Memo</h1></div><div class="head-actions"><button type="button" class="btn btn-primary" data-action="new-memo">+ Scrivi un memo</button></div></div>
    ${all.length ? `<section class="card"><ul class="memos">${all.map((m) => memoItem(m)).join('')}</ul></section>` : emptyState('Nessun memo', 'Scrivi un memo a una o più persone: riceveranno una notifica sul telefono.', '<button type="button" class="btn btn-primary" data-action="new-memo">+ Scrivi un memo</button>')}`, 'memo');
}

function viewPeople() {
  const row = (p) => {
    const n = tasksOf(p.id).length;
    const seen = snap.projects.filter((pr) => pr.status !== 'chiuso' && pr.members.includes(p.id)).length;
    return `<li class="acct">${avatar(p)}<div class="acct-info"><strong>${esc(p.name)}${p.id === me.id ? ' (tu)' : ''}</strong><span class="muted">${p.role === 'admin' ? 'Amministratore' : esc(p.job || 'Team')}</span><span class="acct-mail">${esc(p.email)}</span></div>
      ${p.role === 'member' ? `<span class="acct-n muted">${n} attività · vede ${seen} ${seen === 1 ? 'progetto' : 'progetti'}</span>` : ''}
      <span class="acct-tools"><button type="button" class="link-btn" data-action="edit-person" data-id="${p.id}">Modifica</button>${p.id !== me.id ? `<button type="button" class="link-btn danger" data-action="remove-person" data-id="${p.id}">Togli accesso</button>` : ''}</span></li>`;
  };
  const ap = snap.settings.approval;
  return shell(`
    <div class="page-head"><div><p class="eyebrow">Account e permessi</p><h1>Persone <span class="count">${snap.profiles.length}</span></h1></div><div class="head-actions"><button type="button" class="btn btn-primary" data-action="new-person">+ Aggiungi persona</button></div></div>
    <section class="card"><div class="sec-head"><h2>Amministratori</h2></div><p class="hint">Vedono tutto, creano progetti e attività, approvano le percentuali e decidono chi vede ogni progetto.</p><ul class="accts">${admins().map(row).join('')}</ul></section>
    <section class="card settings"><h2>Chi aggiorna la percentuale</h2>
      <div class="radio-cards" role="radiogroup" aria-label="Chi aggiorna la percentuale">
        <label class="rc"><input type="radio" name="approval" value="1" data-setting="approval"${ap ? ' checked' : ''}><span><strong>Il team propone, un amministratore approva</strong><small>Le modifiche restano in attesa finché un amministratore non le approva.</small></span></label>
        <label class="rc"><input type="radio" name="approval" value="0" data-setting="approval"${ap ? '' : ' checked'}><span><strong>Il team aggiorna liberamente</strong><small>Ogni modifica si vede subito; arriva una notifica quando un’attività è completata.</small></span></label>
      </div></section>
    <section class="card"><div class="sec-head"><h2>Team</h2></div><p class="hint">Quali progetti vede ognuno lo decidi da «Progetti» → «Modifica progetto».</p>
      ${members().length ? `<ul class="accts">${members().map(row).join('')}</ul>` : '<p class="empty">Nessuna persona nel team.</p>'}</section>`, 'persone');
}

function reportRows() {
  return members().map((p) => {
    const list = tasksOf(p.id);
    return { p, total: list.length, done: list.filter((t) => progressOf(t, p.id) >= 100).length, late: lateFor(p.id), avg: personAvg(p.id) };
  });
}
function viewReport() {
  const rows = reportRows();
  return shell(`
    <div class="page-head"><div><p class="eyebrow">Situazione di oggi</p><h1>Report</h1></div><div class="head-actions"><button type="button" class="btn btn-ghost" data-action="backup">Scarica copia dei dati</button><button type="button" class="btn btn-primary" data-action="csv">Scarica (Excel)</button></div></div>
    <p class="hint">Ogni lunedì mattina viene salvata automaticamente una copia di tutti i dati (si tengono le ultime 8). Con «Scarica copia dei dati» ne salvi una anche sul tuo computer.</p>
    <section class="card"><div class="table-wrap"><table class="report">
      <thead><tr><th scope="col">Persona</th><th scope="col">Attività</th><th scope="col">Completate</th><th scope="col">Aperte</th><th scope="col">In ritardo</th><th scope="col">Avanzamento</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><th scope="row"><span class="rp">${avatar(r.p, 'sm')}${esc(r.p.name)}</span></th><td>${r.total}</td><td>${r.done}</td><td>${r.total - r.done}</td><td${r.late ? ' class="txt-late"' : ''}>${r.late}</td><td><span class="rp-bar">${bar(r.avg)}<b>${r.avg}%</b></span></td></tr>`).join('')}</tbody>
    </table></div></section>
    <section class="card"><div class="sec-head"><h2>Storico</h2><span class="muted small">Chi ha fatto cosa e quando</span></div>
      ${snap.log.length ? `<ul class="log">${snap.log.map((l) => `<li><span class="log-at">${esc(fmtAgo(l.at))}</span><span><strong>${esc(l.by)}</strong> ${esc(l.text)}</span></li>`).join('')}</ul>` : '<p class="empty">Ancora nessuna attività registrata.</p>'}
    </section>`, 'report');
}

function viewMe() {
  const list = tasksOf(me.id);
  const memos = memosOf(me.id).sort((a, b) => {
    const ra = myRecipient(a); const rb = myRecipient(b);
    return (ra.done - rb.done) || (ra.read - rb.read) || (a.createdAt < b.createdAt ? 1 : -1);
  });
  const pct = personAvg(me.id);
  const fresh = memos.filter((m) => !myRecipient(m).read).length;
  return shell(`
    <div class="page-head"><div><p class="eyebrow">${esc(new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' }))}</p><h1>Ciao ${esc(me.name)}</h1></div>
      <div class="me-pct"><strong>${pct}%</strong><span>il tuo avanzamento medio</span>${bar(pct, 'bar-lg')}</div></div>
    <div class="two-col me">
      <section class="card folder"><div class="sec-head"><h2>I tuoi memo</h2>${fresh ? `<span class="badge new">${fresh} nuovi</span>` : ''}</div>
        ${memos.length ? `<ul class="memos">${memos.map((m) => memoItem(m, { employee: true })).join('')}</ul>` : '<p class="empty">Nessun memo per te.</p>'}</section>
      <section class="card"><div class="sec-head"><h2>Le tue attività <span class="count">${list.length}</span></h2></div>
        <p class="hint">${snap.settings.approval ? 'Tocca una percentuale: la proposta arriva agli amministratori, che la approvano.' : 'Tocca una percentuale: gli amministratori vedono subito a che punto sei.'}</p>
        ${list.length ? `<ul class="tasks">${list.map((t) => taskRow(t, { forUser: me.id, onlyUser: me.id })).join('')}</ul>` : '<p class="empty">Nessuna attività assegnata.</p>'}</section>
    </div>`, 'io');
}

// ---------- render ----------
let loginProfiles = [];
function render() {
  if (!me) { app.innerHTML = viewLogin(loginProfiles); return; }
  const h = location.hash || '';
  let html;
  if (h.startsWith('#/progetti')) {
    const f = h.slice(11);
    html = viewProjects((f === 'archivio' && isAdmin()) || byId(CATS, f) ? f : '');
  } else if (h.startsWith('#/scadenze')) html = viewDeadlines(h.slice(11));
  else if (!isAdmin()) html = viewMe();
  else if (h.startsWith('#/persona/')) html = viewPerson(h.slice(10));
  else if (h === '#/memo') html = viewMemos();
  else if (h === '#/persone') html = viewPeople();
  else if (h === '#/report') html = viewReport();
  else html = viewTeam();
  app.innerHTML = html;
}

// Live updates must not wipe what someone is typing: wait until they leave the field or close the window.
function typing() {
  const el = document.activeElement;
  return modal.open || (el && app.contains(el) && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}
async function refresh(force = false) {
  if (!me) return;
  if (!force && typing()) { refreshWaiting = true; return; }
  refreshWaiting = false;
  snap = await api.load();
  render();
}
document.addEventListener('focusout', () => { if (refreshWaiting) setTimeout(() => { if (!typing()) refresh(); }, 50); });
modal.addEventListener('close', () => { if (refreshWaiting) refresh(); });

// ---------- modals ----------
function picker(name, selectedIds, opts = {}) {
  const locked = opts.locked || [];
  const list = members();
  return `<fieldset class="field picker"><legend>${opts.legend}</legend>
    <div class="picker-tools"><button type="button" class="link-btn" data-pick-all="${name}">Tutti</button><button type="button" class="link-btn" data-pick-none="${name}">Nessuno</button></div>
    <div class="picker-grid">${list.map((p) => {
      const on = selectedIds.includes(p.id) || locked.includes(p.id);
      return `<label class="pick${on ? ' on' : ''}"><input type="checkbox" name="${name}" value="${p.id}"${on ? ' checked' : ''}${locked.includes(p.id) ? ' disabled' : ''}>${avatar(p, 'xs')}<span>${esc(p.name)}${locked.includes(p.id) ? ' <small>(ha attività)</small>' : ''}</span></label>`;
    }).join('') || '<p class="muted small">Prima aggiungi le persone del team.</p>'}</div></fieldset>`;
}
const picked = (name) => [...modalForm.querySelectorAll(`input[name="${name}"]`)].filter((i) => i.checked).map((i) => i.value);
const projectOptions = (selected) => CATS.map((c) => {
  const list = snap.projects.filter((p) => p.cat === c.id && p.status !== 'chiuso').sort((a, b) => (a.code < b.code ? -1 : 1));
  return list.length ? `<optgroup label="${esc(c.label)}">${list.map((p) => `<option value="${p.id}"${p.id === selected ? ' selected' : ''}>${esc(p.code)} · ${esc(p.name)}</option>`).join('')}</optgroup>` : '';
}).join('');
const catOptions = (sel) => CATS.map((c) => `<option value="${c.id}"${c.id === sel ? ' selected' : ''}>${esc(c.label)} (${c.prefix})</option>`).join('');
const formActions = (label) => `<p class="form-error" data-err hidden></p><div class="modal-actions"><button type="button" class="btn btn-ghost" data-action="close-modal">Annulla</button><button class="btn btn-primary" type="submit">${label}</button></div>`;
const dateQuick = (name) => `<div class="date-quick">${[['Oggi', 0], ['Domani', 1], ['Tra una settimana', 7]].map(([l, n]) => `<button type="button" class="chip" data-date-for="${name}" data-date="${addDays(n)}">${l}</button>`).join('')}</div>`;

function openModal(kind, id, html) {
  modalForm.innerHTML = html;
  modalForm.dataset.kind = kind;
  modalForm.dataset.id = id || '';
  if (typeof modal.showModal === 'function') modal.showModal(); else modal.setAttribute('open', '');
  const first = modalForm.querySelector('input:not([type="checkbox"]):not([type="radio"]), textarea');
  if (first && window.matchMedia('(pointer: fine)').matches) first.focus();
}
function closeModal() { if (modal.open) modal.close(); }
function fail(msg, el) {
  const err = modalForm.querySelector('[data-err]');
  err.textContent = msg;
  err.hidden = false;
  el?.focus();
}

function openTaskModal(task, presetPerson, presetProject) {
  const firstOpen = snap.projects.find((p) => p.status !== 'chiuso');
  const t = task || { title: '', projectId: presetProject || firstOpen?.id || '__new', due: addDays(7), notes: '', priority: 'media', assignees: presetPerson ? [{ userId: presetPerson }] : [] };
  openModal('task', task?.id, `
    <h2>${task ? 'Modifica attività' : 'Nuova attività'}</h2>
    <div class="field"><label for="m-title">Cosa c’è da fare</label><input id="m-title" name="title" maxlength="140" required value="${esc(t.title)}" placeholder="Es. Preventivo copertura campo"></div>
    ${picker('assignees', t.assignees.map((a) => a.userId), { legend: 'Assegnata a (una o più persone)' })}
    <div class="field-row">
      <div class="field"><label for="m-project">Progetto</label><select id="m-project" name="projectId">${projectOptions(t.projectId)}<option value="__new"${t.projectId === '__new' ? ' selected' : ''}>+ Nuovo progetto…</option></select></div>
      <div class="field"><label for="m-prio">Priorità</label><select id="m-prio" name="priority">${PRIO.map((p) => `<option value="${p.id}"${p.id === t.priority ? ' selected' : ''}>${p.label}</option>`).join('')}</select></div>
    </div>
    <div class="field-row" data-newproject${t.projectId === '__new' ? '' : ' hidden'}>
      <div class="field"><label for="m-newproject">Nome del nuovo progetto</label><input id="m-newproject" name="newProject" maxlength="100"></div>
      <div class="field"><label for="m-newcat">Tipologia</label><select id="m-newcat" name="newCat">${catOptions('priv')}</select></div>
    </div>
    <div class="field"><label for="m-due">Scadenza</label><input id="m-due" name="due" type="date" value="${esc(t.due || '')}">${dateQuick('due')}</div>
    <div class="field"><label for="m-notes">Note (facoltative)</label><textarea id="m-notes" name="notes" rows="2" maxlength="1000">${esc(t.notes)}</textarea></div>
    ${task ? '<p class="hint small">Le percentuali di chi resta non cambiano; chi aggiungi parte da 0%.</p>' : '<p class="hint small">Ogni persona ha la sua percentuale. Chi riceve l’attività vede il progetto in automatico.</p>'}
    ${formActions(task ? 'Salva le modifiche' : 'Assegna attività')}`);
}

function openMemoModal(memo, presetPerson) {
  const m = memo || { text: '', forDate: addDays(1), recipients: presetPerson ? [{ userId: presetPerson }] : [] };
  openModal('memo', memo?.id, `
    <h2>${memo ? 'Modifica memo' : 'Nuovo memo'}</h2>
    ${picker('recipients', m.recipients.map((r) => r.userId), { legend: 'Per chi (una o più persone)' })}
    <div class="field"><label for="mm-text">Messaggio</label><textarea id="mm-text" name="text" rows="4" maxlength="1500" required placeholder="Es. Domani devi fare questo, questo e quest’altro…">${esc(m.text)}</textarea></div>
    <div class="field"><label for="mm-date">Per quando</label><input id="mm-date" name="forDate" type="date" value="${esc(m.forDate || '')}">${dateQuick('forDate')}</div>
    ${memo ? '<p class="hint small">Salvando, il memo torna «nuovo» per chi lo riceve e arriva una notifica.</p>' : ''}
    ${formActions(memo ? 'Salva e avvisa' : 'Invia il memo')}`);
}

function openProjectModal(pr) {
  const assignees = pr ? [...new Set(snap.tasks.filter((t) => t.projectId === pr.id).flatMap((t) => t.assignees.map((a) => a.userId)))] : [];
  const p = pr || { name: '', cat: 'priv', status: 'corso', due: addDays(30), members: [] };
  openModal('project', pr?.id, `
    <h2>${pr ? `Modifica ${esc(pr.code)}` : 'Nuovo progetto'}</h2>
    <div class="field"><label for="pj-name">Nome del progetto</label><input id="pj-name" name="name" maxlength="100" required value="${esc(p.name)}" placeholder="Es. Campo da calcetto Rossi"></div>
    <div class="field-row">
      ${pr ? `<div class="field"><span class="label">Tipologia</span><p class="static">${esc(category(pr.cat).label)} · ${esc(pr.code)}</p></div>` : `<div class="field"><label for="pj-cat">Tipologia</label><select id="pj-cat" name="cat">${catOptions(p.cat)}</select></div>`}
      <div class="field"><label for="pj-status">Stato</label><select id="pj-status" name="status">${PSTATUS.filter((s) => pr || s.id !== 'chiuso').map((s) => `<option value="${s.id}"${s.id === p.status ? ' selected' : ''}>${s.label}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label for="pj-due">Consegna</label><input id="pj-due" name="due" type="date" value="${esc(p.due || '')}"></div>
    ${picker('members', p.members, { legend: 'Chi lo vede', locked: assignees })}
    <p class="hint small">Chi è selezionato vede il progetto con tutte le attività e l’avanzamento dei colleghi. Gli amministratori vedono tutto.</p>
    ${pr ? '' : `<p class="code-preview">Codice assegnato in automatico: <strong data-code>${esc(nextCode(snap.projects, 'priv'))}</strong></p>`}
    ${formActions(pr ? 'Salva le modifiche' : 'Crea progetto')}
    ${pr ? `<p class="danger-zone"><button type="button" class="link-btn danger" data-action="delete-project" data-id="${pr.id}">Elimina il progetto e le sue attività</button></p>` : ''}`);
}

function openPersonModal(p) {
  openModal('person', p?.id, `
    <h2>${p ? `Modifica ${esc(p.name)}` : 'Aggiungi una persona'}</h2>
    <div class="field-row">
      <div class="field"><label for="ps-name">Nome</label><input id="ps-name" name="name" maxlength="60" required value="${esc(p?.name || '')}" autocomplete="off"></div>
      <div class="field"><label for="ps-job">Ruolo (facoltativo)</label><input id="ps-job" name="job" maxlength="60" value="${esc(p?.job || '')}" placeholder="Es. Tecnico"></div>
    </div>
    ${p ? `<div class="field"><span class="label">Email</span><p class="static">${esc(p.email)}</p></div>` : '<div class="field"><label for="ps-email">Email (serve per entrare)</label><input id="ps-email" name="email" type="email" maxlength="120" required autocomplete="off"></div>'}
    <div class="field"><label for="ps-role">Tipo di accesso</label><select id="ps-role" name="role"${p?.id === me.id ? ' disabled' : ''}><option value="member"${p?.role !== 'admin' ? ' selected' : ''}>Team</option><option value="admin"${p?.role === 'admin' ? ' selected' : ''}>Amministratore</option></select></div>
    ${TRIAL ? '' : `<div class="field"><label for="ps-pw">${p ? 'Nuova password (lascia vuoto per non cambiarla)' : 'Password iniziale (almeno 8 caratteri)'}</label><input id="ps-pw" name="password" type="text" minlength="8" maxlength="72" autocomplete="new-password"${p ? '' : ' required'}></div>
      <p class="hint small">Comunica la password alla persona: potrà cambiarla dal suo account.</p>`}
    ${formActions(p ? 'Salva' : 'Crea account')}`);
}

function openAccountModal() {
  openModal('account', '', `
    <h2>${esc(me.name)}</h2>
    <p class="muted">${esc(me.email)} · ${isAdmin() ? 'Amministratore' : 'Team'}</p>
    ${TRIAL ? '' : '<div class="field"><label for="ac-pw">Nuova password</label><input id="ac-pw" name="password" type="password" minlength="8" maxlength="72" autocomplete="new-password"></div>'}
    <p class="form-error" data-err hidden></p>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-action="logout">Esci</button>
      ${TRIAL ? '<button type="button" class="btn btn-primary" data-action="close-modal">Chiudi</button>' : '<button class="btn btn-primary" type="submit">Cambia password</button>'}
    </div>`);
}

modalForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = modalForm.elements;
  const kind = modalForm.dataset.kind;
  const id = modalForm.dataset.id || null;

  if (kind === 'task') {
    const title = f.title.value.trim();
    const assignees = picked('assignees');
    if (!title) return fail('Scrivi cosa c’è da fare.', f.title);
    if (!assignees.length) return fail('Scegli almeno una persona.');
    let projectId = f.projectId.value;
    if (projectId === '__new' && !f.newProject.value.trim()) return fail('Scrivi il nome del nuovo progetto.', f.newProject);
    const data = { title, assignees, due: f.due.value, notes: f.notes.value.trim(), priority: f.priority.value };
    closeModal();
    await act(async () => {
      if (projectId === '__new') {
        const res = await api.saveProject({ cat: f.newCat.value, name: f.newProject.value.trim(), status: 'corso', due: '', members: [] });
        projectId = res.project.id;
        log(`ha creato il progetto ${res.project.code} · ${res.project.name}`);
      }
      const res = await api.saveTask({ id, projectId, ...data });
      log(id ? `ha modificato «${title}»` : `ha assegnato «${title}» a ${names(assignees)}`);
      await notify(res.added, `${id ? 'Ti è stata aggiunta' : 'Nuova attività'}: «${title}» · scadenza ${fmtDate(data.due)}`, '#/io');
      if (id) await notify(assignees.filter((u) => !res.added.includes(u)), `Attività modificata: «${title}»`, '#/io');
    }, id ? 'Attività aggiornata.' : `Attività assegnata a ${names(assignees)}.`);
  } else if (kind === 'memo') {
    const text = f.text.value.trim();
    const recipients = picked('recipients');
    if (!recipients.length) return fail('Scegli almeno una persona.');
    if (!text) return fail('Scrivi il messaggio.', f.text);
    const forDate = f.forDate.value;
    closeModal();
    await act(async () => {
      await api.saveMemo({ id, text, forDate, recipients });
      log(id ? `ha modificato un memo per ${names(recipients)}` : `ha scritto un memo a ${names(recipients)}`);
      await notify(recipients, `${id ? 'Memo aggiornato' : 'Nuovo memo'} da ${me.name}: ${short(text, 70)}`, '#/io');
    }, id ? 'Memo aggiornato: le persone ricevono una notifica.' : `Memo inviato a ${names(recipients)}.`);
  } else if (kind === 'project') {
    const name = f.name.value.trim();
    if (!name) return fail('Scrivi il nome del progetto.', f.name);
    const data = { id, cat: f.cat ? f.cat.value : null, name, status: f.status.value, due: f.due.value, members: picked('members') };
    closeModal();
    let code = '';
    await act(async () => {
      const res = await api.saveProject(data);
      code = res.project.code;
      log(id ? `ha modificato il progetto ${code}` : `ha creato il progetto ${code} · ${name}`);
      await notify(res.added, `Ora puoi vedere il progetto ${code} · ${name}`, '#/progetti');
    });
    if (code) { toast(id ? `${code} aggiornato.` : `Progetto ${code} creato.`); if (!id) location.hash = '#/progetti'; }
  } else if (kind === 'person') {
    const name = f.name.value.trim();
    if (!name) return fail('Scrivi il nome.', f.name);
    const patch = { name, job: f.job.value.trim(), role: f.role.disabled ? undefined : f.role.value };
    const password = f.password ? f.password.value : '';
    if (!id) {
      const email = f.email.value.trim().toLowerCase();
      if (!EMAIL_RE.test(email)) return fail('Scrivi un’email valida.', f.email);
      if (!TRIAL && password.length < 8) return fail('La password deve avere almeno 8 caratteri.', f.password);
      closeModal();
      await act(async () => {
        await api.createUser({ ...patch, email, password });
        log(`ha creato l’account di ${name}`);
      }, `Account di ${name} creato.`);
    } else {
      if (password && password.length < 8) return fail('La password deve avere almeno 8 caratteri.', f.password);
      closeModal();
      await act(async () => {
        if (patch.role === undefined) delete patch.role;
        await api.updateUser(id, patch);
        if (password) await api.resetPassword(id, password);
        log(`ha modificato l’account di ${name}`);
      }, password ? 'Salvato, password reimpostata.' : 'Salvato.');
    }
  } else if (kind === 'account') {
    const pw = f.password?.value || '';
    if (pw.length < 8) return fail('La password deve avere almeno 8 caratteri.', f.password);
    try { await api.changePassword(pw); closeModal(); toast('Password cambiata.'); } catch (err) { fail(err.message); }
  }
});

modalForm.addEventListener('change', (e) => {
  const t = e.target;
  if (t.name === 'cat') modalForm.querySelector('[data-code]').textContent = nextCode(snap.projects, t.value);
  if (t.name === 'projectId') modalForm.querySelector('[data-newproject]').hidden = t.value !== '__new';
  if (t.type === 'checkbox') t.closest('.pick')?.classList.toggle('on', t.checked);
});
modalForm.addEventListener('click', (e) => {
  const all = e.target.closest('[data-pick-all]');
  const none = e.target.closest('[data-pick-none]');
  const quick = e.target.closest('[data-date-for]');
  if (all || none) {
    const name = (all || none).getAttribute(all ? 'data-pick-all' : 'data-pick-none');
    modalForm.querySelectorAll(`input[name="${name}"]:not(:disabled)`).forEach((i) => { i.checked = !!all; i.closest('.pick').classList.toggle('on', !!all); });
  }
  if (quick) modalForm.elements[quick.dataset.dateFor].value = quick.dataset.date;
});
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

// ---------- actions ----------
async function changeProgress(taskId, userId, v) {
  const t = byId(snap.tasks, taskId);
  const a = assigneeOf(t, userId);
  if (!t || !a) return;
  if (isAdmin()) {
    const was = a.progress;
    await act(async () => {
      await api.setProgressFor(taskId, userId, v);
      log(`ha portato «${t.title}» di ${nameOf(userId)} al ${v}%`);
      if (userId !== me.id && v !== was) await notify([userId], `${me.name} ha aggiornato «${t.title}» al ${v}%`, '#/io');
    }, `Avanzamento di ${nameOf(userId)}: ${v}%.`);
    return;
  }
  let result = '';
  await act(async () => {
    result = await api.setMyProgress(taskId, v);
    if (result === 'pending') {
      log(`ha proposto ${v}% per «${t.title}»`);
      await notifyAdmins(`${me.name} propone ${v}% per «${t.title}»: da approvare`, '#/team');
    } else if (result === 'applied') {
      log(`ha portato «${t.title}» al ${v}%`);
      if (v === 100 && a.progress < 100) await notifyAdmins(`${me.name} ha completato «${t.title}»`, `#/persona/${me.id}`);
    }
  });
  if (result === 'pending') toast('Proposta inviata agli amministratori.');
  else if (result === 'applied') toast(v === 100 ? `Ottimo! «${t.title}» è completata.` : `Avanzamento: ${v}%.`);
}

document.addEventListener('click', async (e) => {
  // The logo and the tab already open always bring you back to the top of that screen.
  const link = e.target.closest('a[href^="#/"]');
  if (link && link.getAttribute('href') === location.hash) { e.preventDefault(); bellOpen = false; render(); window.scrollTo(0, 0); return; }
  const el = e.target.closest('[data-action]');
  if (!el) {
    if (bellOpen && !e.target.closest('.bell-panel')) { bellOpen = false; render(); }
    return;
  }
  const a = el.dataset.action;
  const id = el.dataset.id;
  const task = el.dataset.task;
  const user = el.dataset.user;
  if (a === 'login-as') { me = await api.signInAs(id); await refresh(true); startLive(); if (location.hash !== homeHash()) location.hash = homeHash(); }
  else if (a === 'logout') { closeModal(); await api.signOut(); me = null; snap = null; await showLogin(); }
  else if (a === 'account') openAccountModal();
  else if (a === 'reset') { if (window.confirm('Svuotare la modalità prova? Si cancellano progetti, attività e memo di prova.')) { await api.reset(); await refresh(true); toast('Modalità prova svuotata.'); } }
  else if (a === 'bell') { bellOpen = !bellOpen; render(); }
  else if (a === 'notes-read') await act(() => api.markNotificationsRead(snap.notifications.filter((n) => !n.read).map((n) => n.id)));
  else if (a === 'open-note') {
    const n = byId(snap.notifications, id);
    bellOpen = false;
    if (n && !n.read) await api.markNotificationsRead([n.id]).catch(() => {});
    if (n?.link && n.link !== location.hash) location.hash = n.link; else await refresh(true);
  }
  else if (a === 'push-on') { try { await enablePush(); } catch (err) { toast(`Notifiche non attivate: ${err.message}`, true); } }
  else if (a === 'new-task') openTaskModal(null, el.dataset.person, el.dataset.project);
  else if (a === 'edit-task') openTaskModal(byId(snap.tasks, id));
  else if (a === 'delete-task') {
    const t = byId(snap.tasks, id);
    if (t && window.confirm(`Eliminare «${t.title}»?`)) await act(async () => { await api.deleteTask(id); log(`ha eliminato «${t.title}»`); }, 'Attività eliminata.');
  }
  else if (a === 'progress') await changeProgress(task, user, Number(el.dataset.v));
  else if (a === 'approve' || a === 'reject') {
    const t = byId(snap.tasks, task);
    const p = assigneeOf(t, user)?.pending;
    await act(async () => {
      await api.decideProgress(task, user, a === 'approve');
      log(`${a === 'approve' ? 'ha approvato' : 'ha rifiutato'} ${p}% di ${nameOf(user)} per «${t.title}»`);
      await notify([user], `${me.name} ha ${a === 'approve' ? 'approvato' : 'rifiutato'} ${p}% per «${t.title}»`, '#/io');
    }, a === 'approve' ? `Approvato: ${nameOf(user)} è al ${p}%.` : 'Proposta rifiutata.');
  }
  else if (a === 'toggle-comments') { openComments[id] = !openComments[id]; render(); if (openComments[id]) document.getElementById(`cm-${id}`)?.focus({ preventScroll: true }); }
  else if (a === 'new-memo') openMemoModal(null, el.dataset.person);
  else if (a === 'edit-memo') openMemoModal(byId(snap.memos, id));
  else if (a === 'delete-memo') { if (window.confirm('Eliminare questo memo?')) await act(() => api.deleteMemo(id), 'Memo eliminato.'); }
  else if (a === 'memo-read' || a === 'memo-done' || a === 'memo-undo') {
    const m = byId(snap.memos, id);
    await act(async () => {
      await api.markMemo(id, true, a === 'memo-done' ? true : a === 'memo-undo' ? false : myRecipient(m).done);
      if (a === 'memo-done') { log('ha segnato come fatto un memo'); await notify([m.author], `${me.name} ha fatto: «${short(m.text, 60)}»`, `#/persona/${me.id}`); }
    }, a === 'memo-done' ? 'Segnato come fatto.' : a === 'memo-read' ? 'Segnato come letto.' : 'Di nuovo da fare.');
  }
  else if (a === 'new-project') openProjectModal();
  else if (a === 'edit-project') openProjectModal(byId(snap.projects, id));
  else if (a === 'delete-project') {
    const pr = byId(snap.projects, id);
    if (pr && window.confirm(`Eliminare ${pr.code} · ${pr.name} con tutte le sue attività? Non si può annullare. Per tenerlo in archivio scegli invece lo stato «Chiuso».`)) {
      closeModal();
      await act(async () => { await api.deleteProject(id); log(`ha eliminato il progetto ${pr.code}`); }, `${pr.code} eliminato.`);
    }
  }
  else if (a === 'new-person') openPersonModal();
  else if (a === 'edit-person') openPersonModal(person(id));
  else if (a === 'remove-person') {
    const p = person(id);
    const open = tasksOf(id).filter((t) => progressOf(t, id) < 100).length;
    if (open && !window.confirm(`${p.name} ha ancora ${open} ${open === 1 ? 'attività aperta' : 'attività aperte'}: verrà tolto/a da quelle attività. Continuare?`)) return;
    if (!open && !window.confirm(`Togliere l’accesso a ${p.name}? Non potrà più entrare.`)) return;
    await act(async () => { await api.deleteUser(id); log(`ha tolto l’accesso a ${p.name}`); }, `Accesso tolto a ${p.name}.`);
  }
  else if (a === 'csv') downloadCsv();
  else if (a === 'backup') {
    try {
      const data = await api.downloadBackup();
      saveFile(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `geco-team-backup-${new Date().toISOString().slice(0, 10)}.json`);
      toast('Copia dei dati scaricata: conservala in un posto sicuro.');
    } catch (err) { toast(err.message, true); }
  }
  else if (a === 'close-modal') closeModal();
});

app.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.matches('[data-setting="approval"]')) {
    const on = t.value === '1';
    await act(async () => { await api.setApproval(on); log(on ? 'ha attivato l’approvazione delle percentuali' : 'ha lasciato libero l’aggiornamento delle percentuali'); },
      on ? 'Ora le percentuali vanno approvate.' : 'Il team aggiorna le percentuali liberamente.');
  }
});

app.addEventListener('submit', async (e) => {
  const form = e.target;
  e.preventDefault();
  if (form.matches('[data-login]')) {
    const err = form.querySelector('[data-err]');
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      me = await api.signIn(form.elements.email.value.trim(), form.elements.password.value);
      await refresh(true);
      if (location.hash !== homeHash()) location.hash = homeHash();
      startLive();
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false; btn.disabled = false;
    }
    return;
  }
  if (form.matches('[data-comment]')) {
    const text = form.elements.text.value.trim();
    if (!text) return;
    const t = byId(snap.tasks, form.dataset.comment);
    form.elements.text.blur();
    await act(async () => {
      await api.addComment(t.id, text);
      log(`ha commentato «${t.title}»`);
      await notify([...t.assignees.map((a) => a.userId), ...admins().map((a) => a.id)], `${me.name} ha commentato «${t.title}»: ${short(text, 50)}`, isAdmin() ? '#/io' : `#/persona/${t.assignees[0]?.userId || ''}`);
    });
  }
});

function downloadCsv() {
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const lines = [['Persona', 'Attività', 'Completate', 'In ritardo', 'Avanzamento %'].map(q).join(';')];
  reportRows().forEach((r) => lines.push([r.p.name, r.total, r.done, r.late, r.avg].map(q).join(';')));
  lines.push('');
  lines.push(['Attività', 'Progetto', 'Persona', 'Priorità', 'Scadenza', 'Avanzamento %'].map(q).join(';'));
  liveTasks().sort(byUrgency()).forEach((t) => {
    const pr = project(t.projectId);
    t.assignees.forEach((a) => lines.push([t.title, pr ? `${pr.code} · ${pr.name}` : '', nameOf(a.userId), prio(t.priority).label, t.due || '', a.progress].map(q).join(';')));
  });
  saveFile(new Blob([`﻿${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' }), `report-team-geco-${new Date().toISOString().slice(0, 10)}.csv`);
  toast('Report scaricato: si apre con Excel.');
}

function saveFile(blob, filename) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 1000);
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && bellOpen) { bellOpen = false; render(); } });
window.addEventListener('hashchange', () => { bellOpen = false; render(); window.scrollTo(0, 0); });

// ---------- start ----------
let stopLive = null;
function startLive() {
  stopLive?.();
  stopLive = api.onChange(() => refresh());
}
async function showLogin() {
  stopLive?.();
  loginProfiles = TRIAL ? await api.listLoginProfiles() : [];
  render();
}
async function start() {
  if ('serviceWorker' in navigator && !TRIAL) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try {
    me = await api.getUser();
  } catch {
    me = null;
  }
  if (!me) { await showLogin(); return; }
  await refresh(true);
  startLive();
  // Refresh when the app comes back to the foreground (phones pause background tabs).
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
}
start().catch((e) => { app.innerHTML = `<main class="wrap main"><div class="card"><h1>Errore</h1><p>${esc(e.message)}</p></div></main>`; });
