import { describe, expect, it } from 'vitest';
import { exportAll, saveBackup } from '../api/_lib.js';
import backup from '../api/backup.js';

function fakeDb(existing = []) {
  const files = [...existing];
  const removed = [];
  return {
    files, removed,
    from: (t) => ({ select: async () => ({ data: [{ table: t }], error: null }) }),
    storage: {
      createBucket: async () => ({}),
      from: () => ({
        upload: async (name) => { if (!files.includes(name)) files.push(name); return { error: null }; },
        list: async () => ({ data: files.slice().sort().reverse().map((name) => ({ name })) }),
        remove: async (names) => { removed.push(...names); return {}; },
      }),
    },
  };
}

describe('backups', () => {
  it('exports every team table', async () => {
    const out = await exportAll(fakeDb());
    expect(Object.keys(out.tables)).toEqual(expect.arrayContaining(['profiles', 'projects', 'tasks', 'task_assignees', 'memos', 'memo_recipients']));
    expect(out.tables.notifications).toBeUndefined();
  });

  it('keeps only the latest 8 weekly copies', async () => {
    const old = Array.from({ length: 8 }, (_, i) => `backup-2026-0${1 + Math.floor(i / 4)}-1${i}.json`);
    const db = fakeDb(old);
    const name = await saveBackup(db, '2026-10-26');
    expect(name).toBe('backup-2026-10-26.json');
    expect(db.removed).toHaveLength(1);
    expect(db.removed[0]).not.toBe('backup-2026-10-26.json');
  });

  it('refuses downloads to people who are not signed in', async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'x';
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    const res = { status(c) { this.statusCode = c; return this; }, setHeader() { return this; }, send(b) { this.body = JSON.parse(b); return this; } };
    await backup({ method: 'GET', headers: {} }, res);
    expect(res.statusCode).toBe(401);
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });
});
