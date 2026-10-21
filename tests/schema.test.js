// Runs supabase/schema.sql in an in-process Postgres (PGlite) with a minimal stand-in for Supabase's auth schema,
// then checks the access rules as an administrator and as team members.
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';

const ADMIN = '00000000-0000-0000-0000-00000000000a';
const LUCA = '00000000-0000-0000-0000-000000000001';
const SARA = '00000000-0000-0000-0000-000000000002';
let db;

async function as(user, sql, params) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${user}', false); set role authenticated;`);
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec('reset role;');
  }
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid() to authenticated;
    create publication supabase_realtime;
  `);
  const schema = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8')
    .replace(/create extension[^;]*;/i, '');
  await db.exec(schema);
  await db.exec(`
    grant usage on schema public to authenticated;
    grant all on all tables in schema public to authenticated;
    grant all on all sequences in schema public to authenticated;
    insert into auth.users values ('${ADMIN}', 'g@x.it'), ('${LUCA}', 'l@x.it'), ('${SARA}', 's@x.it');
    insert into public.profiles (id, name, email, role) values
      ('${ADMIN}', 'Giorgio', 'g@x.it', 'admin'), ('${LUCA}', 'Luca', 'l@x.it', 'member'), ('${SARA}', 'Sara', 's@x.it', 'member');
  `);
});

describe('schema and access rules', () => {
  let projectA;
  let projectB;
  let task;

  it('gives projects an automatic code per type', async () => {
    const r1 = await as(ADMIN, "insert into projects (cat, name) values ('priv', 'Campo padel') returning id, code");
    const r2 = await as(ADMIN, "insert into projects (cat, name) values ('priv', 'Palestra') returning id, code");
    const r3 = await as(ADMIN, "insert into projects (cat, name) values ('gara', 'Bando') returning code");
    expect(r1.rows[0].code).toBe('PRIV-001');
    expect(r2.rows[0].code).toBe('PRIV-002');
    expect(r3.rows[0].code).toBe('GARA-001');
    projectA = r1.rows[0].id;
    projectB = r2.rows[0].id;
  });

  it('hides projects from members until an admin opens them', async () => {
    expect((await as(LUCA, 'select id from projects')).rows).toHaveLength(0);
    await as(ADMIN, 'insert into project_members (project_id, user_id) values ($1, $2)', [projectB, LUCA]);
    const seen = (await as(LUCA, 'select id from projects')).rows.map((r) => r.id);
    expect(seen).toEqual([projectB]);
  });

  it('opens the project automatically to whoever gets a task in it', async () => {
    const t = await as(ADMIN, "insert into tasks (project_id, title) values ($1, 'Ordine vetri') returning id", [projectA]);
    task = t.rows[0].id;
    await as(ADMIN, 'insert into task_assignees (task_id, user_id) values ($1, $2), ($1, $3)', [task, LUCA, SARA]);
    expect((await as(SARA, 'select id from projects')).rows.map((r) => r.id)).toEqual([projectA]);
    expect((await as(SARA, 'select user_id from task_assignees where task_id = $1', [task])).rows).toHaveLength(2);
  });

  it('does not let members create or change projects and tasks', async () => {
    await expect(as(LUCA, "insert into projects (cat, name) values ('pub', 'Mio')")).rejects.toThrow();
    await as(LUCA, "update tasks set title = 'cambiato' where id = $1", [task]);
    expect((await as(ADMIN, 'select title from tasks where id = $1', [task])).rows[0].title).toBe('Ordine vetri');
    await as(LUCA, 'update task_assignees set progress = 100 where task_id = $1', [task]);
    expect((await as(ADMIN, 'select progress from task_assignees where task_id = $1 and user_id = $2', [task, LUCA])).rows[0].progress).toBe(0);
  });

  it('keeps a member percentage as a proposal until an admin approves it', async () => {
    expect((await as(LUCA, 'select public.set_my_progress($1, 60) as r', [task])).rows[0].r).toBe('pending');
    let row = (await as(ADMIN, 'select progress, pending from task_assignees where task_id = $1 and user_id = $2', [task, LUCA])).rows[0];
    expect(row).toEqual({ progress: 0, pending: 60 });
    await as(ADMIN, 'select public.decide_progress($1, $2, true)', [task, LUCA]);
    row = (await as(ADMIN, 'select progress, pending from task_assignees where task_id = $1 and user_id = $2', [task, LUCA])).rows[0];
    expect(row).toEqual({ progress: 60, pending: null });
    // Sara's own percentage is separate and unchanged.
    expect((await as(ADMIN, 'select progress from task_assignees where task_id = $1 and user_id = $2', [task, SARA])).rows[0].progress).toBe(0);
  });

  it('applies percentages at once when approval is switched off', async () => {
    await as(ADMIN, 'select public.set_approval(false)');
    expect((await as(SARA, 'select public.set_my_progress($1, 40) as r', [task])).rows[0].r).toBe('applied');
    await expect(as(SARA, 'select public.decide_progress($1, $2, true)', [task, LUCA])).rejects.toThrow(/amministratori/);
    await as(ADMIN, 'select public.set_approval(true)');
  });

  it('shows memos only to their recipients', async () => {
    const m = await as(ADMIN, "insert into memos (text, author) values ('Domani sopralluogo', $1) returning id", [ADMIN]);
    const memo = m.rows[0].id;
    await as(ADMIN, 'insert into memo_recipients (memo_id, user_id) values ($1, $2)', [memo, LUCA]);
    expect((await as(LUCA, 'select id from memos')).rows).toHaveLength(1);
    expect((await as(SARA, 'select id from memos')).rows).toHaveLength(0);
    await as(LUCA, 'select public.mark_memo($1, true, true)', [memo]);
    expect((await as(ADMIN, 'select read, done from memo_recipients where memo_id = $1', [memo])).rows[0]).toEqual({ read: true, done: true });
    await expect(as(SARA, 'select public.mark_memo($1, true, false)', [memo])).rejects.toThrow();
  });

  it('notifies other people only, and each person reads only their own notifications', async () => {
    const ids = await as(LUCA, 'select * from public.notify($1::uuid[], $2, $3)', [[ADMIN, LUCA], 'Luca propone 60%', '#/team']);
    expect(ids.rows).toHaveLength(1);
    expect((await as(ADMIN, 'select text from notifications')).rows.map((r) => r.text)).toEqual(['Luca propone 60%']);
    expect((await as(LUCA, 'select id from notifications')).rows).toHaveLength(0);
  });

  it('lets members comment only on tasks they can see', async () => {
    await as(SARA, 'insert into comments (task_id, author, text) values ($1, $2, $3)', [task, SARA, 'Materiale arrivato']);
    const hidden = await as(ADMIN, "insert into tasks (project_id, title) values ($1, 'Riservata') returning id", [projectB]);
    await expect(as(SARA, 'insert into comments (task_id, author, text) values ($1, $2, $3)', [hidden.rows[0].id, SARA, 'x'])).rejects.toThrow();
  });
});
