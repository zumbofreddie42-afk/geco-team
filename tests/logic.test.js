import { describe, expect, it } from 'vitest';
import { avg, byUrgency, canSeeProject, daysFromToday, diffIds, fmtDate, isLate, nextCode, status, taskAvg } from '../src/logic.js';

const NOW = new Date('2026-10-21T10:00:00');

describe('dates', () => {
  it('describes nearby days in words', () => {
    expect(fmtDate('2026-10-21', NOW)).toBe('oggi');
    expect(fmtDate('2026-10-22', NOW)).toBe('domani');
    expect(fmtDate('2026-10-20', NOW)).toBe('ieri');
    expect(fmtDate('2026-10-26', NOW)).toBe('lun 26 ott');
    expect(fmtDate(null, NOW)).toBe('senza scadenza');
    expect(daysFromToday('2026-11-01', NOW)).toBe(11);
  });
});

describe('progress', () => {
  const task = { due: '2026-10-20', priority: 'alta', assignees: [{ userId: 'a', progress: 40 }, { userId: 'b', progress: 100 }] };

  it('averages each person percentage', () => {
    expect(taskAvg(task)).toBe(70);
    expect(avg([])).toBe(0);
  });

  it('marks late only what is still open', () => {
    expect(isLate(task.due, 40, NOW)).toBe(true);
    expect(isLate(task.due, 100, NOW)).toBe(false);
    expect(status(task.due, 40, NOW).label).toBe('In ritardo');
    expect(status('2026-10-21', 10, NOW).label).toBe('Scade oggi');
    expect(status('2026-10-30', 0, NOW).label).toBe('Da iniziare');
  });

  it('sorts open items first, then by deadline and priority', () => {
    const list = [
      { id: 1, due: '2026-10-25', priority: 'bassa', assignees: [{ progress: 0 }] },
      { id: 2, due: '2026-10-22', priority: 'bassa', assignees: [{ progress: 100 }] },
      { id: 3, due: '2026-10-25', priority: 'alta', assignees: [{ progress: 10 }] },
      { id: 4, due: null, priority: 'alta', assignees: [{ progress: 0 }] },
    ];
    expect(list.sort(byUrgency()).map((t) => t.id)).toEqual([3, 1, 4, 2]);
  });
});

describe('projects', () => {
  it('numbers codes per type', () => {
    const projects = [{ cat: 'priv', code: 'PRIV-001' }, { cat: 'priv', code: 'PRIV-007' }, { cat: 'gara', code: 'GARA-002' }];
    expect(nextCode(projects, 'priv')).toBe('PRIV-008');
    expect(nextCode(projects, 'pub')).toBe('PUB-001');
  });

  it('applies the same visibility rule as the database', () => {
    const p = { members: ['luca'] };
    expect(canSeeProject(p, { id: 'luca', role: 'member' })).toBe(true);
    expect(canSeeProject(p, { id: 'sara', role: 'member' })).toBe(false);
    expect(canSeeProject(p, { id: 'giorgio', role: 'admin' })).toBe(true);
  });

  it('finds who was added and removed', () => {
    expect(diffIds(['a', 'b'], ['b', 'c'])).toEqual({ added: ['c'], removed: ['a'] });
  });
});
