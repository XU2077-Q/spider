const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'work-buddy.json');
const DEFAULTS = Object.freeze({
  focusMinutes: 25,
  breakMinutes: 5,
  maxFocusMinutes: 240,
  maxBreakMinutes: 120,
  historyLimit: 500,
});
const VALID_STATUSES = new Set(['idle', 'running', 'paused', 'completed']);
let tempFileCounter = 0;

function initialState() {
  return { mode: 'idle', status: 'idle', current: null, sessions: [] };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function dateStr(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function createService(options = {}) {
  const file = options.file || options.filePath || DEFAULT_FILE;
  const clock = options.clock || options.now || (() => Date.now());
  const historyLimit = options.historyLimit === undefined ? DEFAULTS.historyLimit : options.historyLimit;
  if (!Number.isInteger(historyLimit) || historyLimit < 1) {
    throw new RangeError('historyLimit must be a positive integer');
  }

  function nowMs() {
    const value = typeof clock === 'function' ? clock() : clock.now();
    const ms = value instanceof Date ? value.getTime() : value;
    if (!Number.isFinite(ms)) throw new TypeError('clock must return a valid time');
    return ms;
  }

  function load() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!data || typeof data !== 'object') return initialState();
      const current = data.current && typeof data.current === 'object' ? data.current : null;
      const status = VALID_STATUSES.has(data.status) ? data.status : 'idle';
      if (!current && status !== 'idle') return initialState();
      return {
        mode: current && (current.mode === 'focus' || current.mode === 'break') ? current.mode : 'idle',
        status: current ? status : 'idle',
        current,
        sessions: Array.isArray(data.sessions)
          ? data.sessions.filter((session) => session && typeof session === 'object').slice(-historyLimit)
          : [],
      };
    } catch {
      return initialState();
    }
  }

  let state = load();

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tempFile = `${file}.${process.pid}.${tempFileCounter++}.tmp`;
    try {
      fs.writeFileSync(tempFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
      fs.renameSync(tempFile, file);
    } catch (error) {
      try { fs.unlinkSync(tempFile); } catch {}
      throw error;
    }
  }

  function publicState() {
    const result = clone(state);
    if (result.current && result.status === 'running') {
      result.current.remainingMs = Math.max(0, Date.parse(result.current.endAt) - nowMs());
    }
    return result;
  }

  function result(events = []) {
    return { state: publicState(), events };
  }

  function validateTodoId(todoId) {
    if (todoId === undefined || todoId === null) return null;
    if (typeof todoId === 'string' && todoId.trim()) return todoId;
    if (typeof todoId === 'number' && Number.isFinite(todoId)) return todoId;
    throw new TypeError('todoId must be a non-empty string, a finite number, or null');
  }

  function sessionArgs(defaultMinutes, maxMinutes, durationOrOptions, linkedTodoId) {
    let durationMin = defaultMinutes;
    let todoId = linkedTodoId;
    if (durationOrOptions && typeof durationOrOptions === 'object' && !Array.isArray(durationOrOptions)) {
      durationMin = durationOrOptions.durationMin === undefined
        ? defaultMinutes
        : durationOrOptions.durationMin;
      todoId = durationOrOptions.todoId;
    } else if (durationOrOptions !== undefined) {
      durationMin = durationOrOptions;
    }
    if (!Number.isFinite(durationMin) || !Number.isInteger(durationMin)) {
      throw new TypeError('durationMin must be a finite integer');
    }
    if (durationMin < 1 || durationMin > maxMinutes) {
      throw new RangeError(`durationMin must be between 1 and ${maxMinutes}`);
    }
    return { durationMin, todoId: validateTodoId(todoId) };
  }

  function start(mode, durationOrOptions, linkedTodoId) {
    if (state.status === 'running' || state.status === 'paused') {
      throw new Error('Stop or complete the active session before starting another');
    }
    const isFocus = mode === 'focus';
    const args = sessionArgs(
      isFocus ? DEFAULTS.focusMinutes : DEFAULTS.breakMinutes,
      isFocus ? DEFAULTS.maxFocusMinutes : DEFAULTS.maxBreakMinutes,
      durationOrOptions,
      linkedTodoId
    );
    const startedAt = nowMs();
    state.mode = mode;
    state.status = 'running';
    state.current = {
      id: randomUUID(),
      mode,
      startAt: new Date(startedAt).toISOString(),
      endAt: new Date(startedAt + args.durationMin * 60000).toISOString(),
      durationMin: args.durationMin,
      todoId: args.todoId,
      remainingMs: null,
      completedAt: null,
    };
    save();
    return result();
  }

  function startFocus(durationOrOptions, todoId) {
    return start('focus', durationOrOptions, todoId);
  }

  function startBreak(durationOrOptions, todoId) {
    return start('break', durationOrOptions, todoId);
  }

  function completeIfDue() {
    if (state.status !== 'running' || nowMs() < Date.parse(state.current.endAt)) return [];
    const completedAt = state.current.endAt;
    state.status = 'completed';
    state.current.remainingMs = 0;
    state.current.completedAt = completedAt;
    state.sessions.push(clone(state.current));
    state.sessions = state.sessions.slice(-historyLimit);
    save();
    return [{ type: 'sessionCompleted', session: clone(state.current) }];
  }

  function pause() {
    if (state.status !== 'running') return result();
    const events = completeIfDue();
    if (events.length) return result(events);
    state.status = 'paused';
    state.current.remainingMs = Math.max(0, Date.parse(state.current.endAt) - nowMs());
    state.current.endAt = null;
    save();
    return result();
  }

  function resume() {
    if (state.status !== 'paused') return result();
    state.status = 'running';
    state.current.endAt = new Date(nowMs() + state.current.remainingMs).toISOString();
    state.current.remainingMs = null;
    save();
    return result();
  }

  function stop() {
    state = initialState();
    save();
    return result();
  }

  function tick() {
    return result(completeIfDue());
  }

  function getState() {
    return publicState();
  }

  function getSummary(date) {
    let day;
    if (date === undefined) {
      day = dateStr(new Date(nowMs()));
    } else if (date instanceof Date) {
      if (!Number.isFinite(date.getTime())) throw new TypeError('date must be valid');
      day = dateStr(date);
    } else if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const [year, month, dayOfMonth] = date.split('-').map(Number);
      const daysInMonth = new Date(year, month, 0).getDate();
      if (month < 1 || month > 12 || dayOfMonth < 1 || dayOfMonth > daysInMonth) {
        throw new RangeError('date must be a valid calendar day');
      }
      day = date;
    } else {
      throw new TypeError('date must be a Date or YYYY-MM-DD string');
    }

    const sessions = state.sessions.filter((session) => (
      session.completedAt && dateStr(new Date(session.completedAt)) === day
    ));
    const focus = sessions.filter((session) => session.mode === 'focus');
    const breaks = sessions.filter((session) => session.mode === 'break');
    return {
      date: day,
      focusMinutes: focus.reduce((total, session) => total + session.durationMin, 0),
      breakMinutes: breaks.reduce((total, session) => total + session.durationMin, 0),
      focusSessions: focus.length,
      breakSessions: breaks.length,
      totalSessions: sessions.length,
      completedSessionIds: sessions.map((session) => session.id),
    };
  }

  return { startFocus, pause, resume, stop, startBreak, getState, tick, getSummary };
}

module.exports = { createService, DEFAULTS };
