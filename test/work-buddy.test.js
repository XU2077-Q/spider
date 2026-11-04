const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createService } = require('../agent/work-buddy');

function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-buddy-'));
  const file = path.join(dir, 'work-buddy.json');
  let now = new Date(2026, 0, 15, 10, 0, 0).getTime();
  const service = createService({
    file,
    clock: { now: () => now },
    ...options,
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    file,
    service,
    now: () => now,
    advance(ms) { now += ms; },
    recreate() { return createService({ file, clock: { now: () => now }, ...options }); },
  };
}

function finish(harness, mode, durationMin, todoId) {
  const started = mode === 'focus'
    ? harness.service.startFocus(durationMin, todoId)
    : harness.service.startBreak(durationMin, todoId);
  harness.advance(durationMin * 60000);
  const completed = harness.service.tick();
  assert.equal(completed.events.length, 1);
  return { id: started.state.current.id, completed };
}

test('starts focus and break sessions with defaults and linked todos', (t) => {
  const h = setup(t);
  const initial = h.service.getState();
  assert.equal(initial.mode, 'idle');
  assert.equal(initial.status, 'idle');

  const focus = h.service.startFocus({ todoId: 'todo-1' });
  assert.equal(focus.state.mode, 'focus');
  assert.equal(focus.state.status, 'running');
  assert.equal(focus.state.current.durationMin, 25);
  assert.equal(focus.state.current.todoId, 'todo-1');
  assert.equal(Date.parse(focus.state.current.endAt) - h.now(), 25 * 60000);
  assert.deepEqual(focus.events, []);

  h.service.stop();
  const breakResult = h.service.startBreak();
  assert.equal(breakResult.state.mode, 'break');
  assert.equal(breakResult.state.current.durationMin, 5);
});

test('pause preserves remaining time and resume restores endAt', (t) => {
  const h = setup(t);
  h.service.startFocus(25);
  h.advance(5 * 60000);

  const paused = h.service.pause();
  assert.equal(paused.state.status, 'paused');
  assert.equal(paused.state.current.endAt, null);
  assert.equal(paused.state.current.remainingMs, 20 * 60000);

  h.advance(10 * 60000);
  assert.deepEqual(h.service.tick().events, []);
  assert.equal(h.service.getState().current.remainingMs, 20 * 60000);

  const resumed = h.service.resume();
  assert.equal(resumed.state.status, 'running');
  assert.equal(resumed.state.current.remainingMs, 20 * 60000);
  assert.equal(Date.parse(resumed.state.current.endAt) - h.now(), 20 * 60000);

  h.advance(20 * 60000);
  const completed = h.service.tick();
  assert.equal(completed.state.status, 'completed');
  assert.equal(completed.events.length, 1);
  assert.equal(completed.events[0].session.durationMin, 25);
});

test('restores a running session and completes an overdue session on tick', (t) => {
  const h = setup(t);
  const started = h.service.startFocus(1, 'restore-me');
  const id = started.state.current.id;
  h.advance(90000);

  const restored = h.recreate();
  const beforeTick = restored.getState();
  assert.equal(beforeTick.status, 'running');
  assert.equal(beforeTick.current.id, id);
  assert.equal(beforeTick.current.remainingMs, 0);
  assert.equal(beforeTick.sessions.length, 0);

  const completed = restored.tick();
  assert.equal(completed.events.length, 1);
  assert.equal(completed.events[0].type, 'sessionCompleted');
  assert.equal(completed.events[0].session.id, id);
  assert.equal(completed.events[0].session.todoId, 'restore-me');
  assert.equal(completed.state.sessions.length, 1);
  assert.equal(completed.state.current.completedAt, completed.state.current.endAt);
});

test('completion and its event occur exactly once across ticks and reloads', (t) => {
  const h = setup(t);
  h.service.startFocus(1);
  h.advance(60000);

  const first = h.service.tick();
  const second = h.service.tick();
  assert.equal(first.events.length, 1);
  assert.deepEqual(second.events, []);
  assert.equal(second.state.sessions.length, 1);

  const restored = h.recreate();
  const afterReload = restored.tick();
  assert.deepEqual(afterReload.events, []);
  assert.equal(afterReload.state.sessions.length, 1);
  assert.deepEqual(restored.getSummary().completedSessionIds, [first.events[0].session.id]);
});

test('paused state and session history persist as JSON without temp files', (t) => {
  const h = setup(t);
  h.service.startFocus(10, 42);
  h.advance(40000);
  h.service.pause();

  const restored = h.recreate();
  assert.equal(restored.getState().status, 'paused');
  assert.equal(restored.getState().current.remainingMs, 10 * 60000 - 40000);
  assert.equal(restored.getState().current.todoId, 42);

  restored.resume();
  h.advance(10 * 60000);
  restored.tick();
  const persisted = JSON.parse(fs.readFileSync(h.file, 'utf8'));
  assert.equal(persisted.sessions.length, 1);
  assert.equal(persisted.sessions[0].mode, 'focus');
  assert.equal(fs.readdirSync(h.dir).filter((name) => name.endsWith('.tmp')).length, 0);
});

test('daily summaries are deterministic and separate focus from breaks', (t) => {
  const h = setup(t);
  const first = finish(h, 'focus', 2, 'a');
  const second = finish(h, 'focus', 3, 'b');
  const breakSession = finish(h, 'break', 1);

  const day = '2026-01-15';
  const expected = {
    date: day,
    focusMinutes: 5,
    breakMinutes: 1,
    focusSessions: 2,
    breakSessions: 1,
    totalSessions: 3,
    completedSessionIds: [first.id, second.id, breakSession.id],
  };
  assert.deepEqual(h.service.getSummary(day), expected);
  assert.deepEqual(h.service.getSummary(day), expected);
  assert.deepEqual(h.service.getSummary(new Date(2026, 0, 15)), expected);
  assert.deepEqual(h.service.getSummary('2026-01-16'), {
    date: '2026-01-16',
    focusMinutes: 0,
    breakMinutes: 0,
    focusSessions: 0,
    breakSessions: 0,
    totalSessions: 0,
    completedSessionIds: [],
  });
});

test('history is limited to the newest completed sessions', (t) => {
  const h = setup(t, { historyLimit: 2 });
  const first = finish(h, 'focus', 1);
  const second = finish(h, 'focus', 1);
  const third = finish(h, 'break', 1);

  const state = h.service.getState();
  assert.deepEqual(state.sessions.map((session) => session.id), [second.id, third.id]);
  assert.ok(!state.sessions.some((session) => session.id === first.id));
  assert.deepEqual(h.recreate().getState().sessions.map((session) => session.id), [second.id, third.id]);
});

test('stop clears the active session without recording a completion', (t) => {
  const h = setup(t);
  h.service.startFocus(1);
  h.advance(30000);
  const stopped = h.service.stop();
  assert.equal(stopped.state.mode, 'idle');
  assert.equal(stopped.state.status, 'idle');
  assert.equal(stopped.state.current, null);
  h.advance(60000);
  assert.deepEqual(h.service.tick().events, []);
  assert.equal(h.service.getSummary().totalSessions, 0);
});

test('rejects invalid durations, todo IDs, dates, and history limits', (t) => {
  const h = setup(t);
  for (const duration of [0, -1, 1.5, NaN, Infinity, '25', 241]) {
    assert.throws(() => h.service.startFocus(duration));
  }
  for (const duration of [0, -5, 121]) {
    assert.throws(() => h.service.startBreak(duration));
  }
  assert.throws(() => h.service.startFocus({ durationMin: 25, todoId: '' }));
  assert.throws(() => h.service.startFocus(25, {}));
  assert.throws(() => h.service.getSummary('not-a-date'));
  assert.throws(() => h.service.getSummary('2026-02-30'));
  assert.throws(() => createService({ file: h.file, historyLimit: 0 }));
  assert.equal(h.service.getState().status, 'idle');
});
