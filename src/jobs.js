// Jobs: progress and cancel for long requests (imports, previews, writes). A request that carries a job id
// (HTTP header x-sieve-job) runs inside an AsyncLocalStorage context; core reports progress() and checks for a
// cancel at its steps. Cancel aborts network reads at once and interrupts the running DuckDB query when no other
// job is running; otherwise the job stops at its next step. Calls without a job id (MCP, tests) are unaffected.
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();
const jobs = new Map();
const KEEP_MS = 60_000;

export const current = () => als.getStore();
export function runJob(id, fn) {
  if (!id) return fn();
  if (!/^[\w-]{1,64}$/.test(String(id))) throw new Error('job id: letters, digits, _ and - (max 64)');
  const j = { id: String(id), phase: 'Starting', done: null, total: null, started: Date.now(), cancelled: false, ctl: new AbortController(), hooks: new Set(), phases: [] };
  jobs.set(j.id, j);
  const end = () => { j.finished = Date.now(); setTimeout(() => jobs.get(j.id) === j && jobs.delete(j.id), KEEP_MS).unref?.(); };
  try { return Promise.resolve(als.run(j, fn)).finally(end); } catch (e) { end(); throw e; }
}
export const cancelledError = () => Object.assign(new Error('Cancelled'), { kind: 'cancelled' });
export function checkCancel() { if (current()?.cancelled) throw cancelledError(); }
// phase text plus optional done/total (rows, bytes, steps); also a cancel point
export function report(phase, done = null, total = null, unit) {
  const j = current();
  if (j && !j.cancelled) { Object.assign(j, { phase, done, total, unit: unit || null }); if (j.phases.at(-1) !== phase) j.phases = [...j.phases.slice(-19), phase]; }
}
export function progress(phase, done, total, unit) { report(phase, done, total, unit); checkCancel(); }
export const signal = () => current()?.ctl.signal;
// run f on cancel (e.g. interrupt a DuckDB connection); returns an unregister function
export function onCancel(f) { const j = current(); if (!j) return () => {}; j.hooks.add(f); return () => j.hooks.delete(f); }
export const running = () => [...jobs.values()].filter((j) => !j.finished).length;
export function cancel(id) {
  const j = jobs.get(String(id));
  if (!j) return { id, found: false };
  if (!j.finished && !j.cancelled) {
    j.cancelled = true; j.phase = 'Cancelling'; j.ctl.abort();
    for (const f of j.hooks) { try { f(); } catch {} }
  }
  return { id: j.id, found: true, cancelled: j.cancelled, finished: !!j.finished, phases: j.phases };
}
export function status(id) {
  const j = jobs.get(String(id));
  if (!j) throw new Error(`no job "${id}"`);
  return { id: j.id, phase: j.phase, done: j.done, total: j.total, unit: j.unit, elapsed_ms: (j.finished || Date.now()) - j.started, cancelled: j.cancelled, finished: !!j.finished, phases: j.phases };
}
// A cancel shows up as an aborted fetch or an interrupted query; report it as "Cancelled".
export function asCancel(e) {
  if (current()?.cancelled && (e?.name === 'AbortError' || /interrupt|abort/i.test(String(e?.message)))) return cancelledError();
  return e;
}
