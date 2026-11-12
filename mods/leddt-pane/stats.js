// CPU and memory of what runs in a terminal: its root process (hc's `pid`) and
// every descendant, since the program is usually a child of the shell.
// One process table for every pane header (module code is shared by copies),
// read at most once per INTERVAL by whichever copy asks first. CPU is the tree's CPU time between two
// reads, so it needs two of them.

import { exec, hc, window } from "herdr";

export const INTERVAL = 5000;

// One line per process: pid, parent pid, resident bytes, CPU seconds so far.
// Windows: a "cores N" line first. A PowerShell start costs ~0.4s of one core.
const WINDOWS = "'cores ' + $env:NUMBER_OF_PROCESSORS; "
  + "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime | "
  + "ForEach-Object { '{0} {1} {2} {3}' -f $_.ProcessId, $_.ParentProcessId, $_.WorkingSetSize, (($_.KernelModeTime + $_.UserModeTime) / 1e7) }";

// ps prints CPU time as [dd-]hh:mm:ss (Linux) or mm:ss.cc (macOS).
function seconds(time) {
  const [rest, days] = time.split("-").reverse();
  return rest.split(":").reduce((s, part) => s * 60 + Number(part), 0) + (Number(days) || 0) * 86400;
}

async function readTable() {
  const procs = new Map();
  let cores = 0;
  if (window().platform === "windows") {
    const r = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS], { timeout: 15000 });
    for (const line of r.stdout.split(/\r?\n/)) {
      const f = line.trim().split(/\s+/);
      if (f[0] === "cores") { cores = Number(f[1]) || 0; continue; }
      // The decimal separator follows the system's culture.
      const pid = Number(f[0]), cpu = Number((f[3] ?? "").replace(",", "."));
      if (pid && f.length === 4 && !Number.isNaN(cpu)) procs.set(pid, { ppid: Number(f[1]), rss: Number(f[2]) || 0, cpu });
    }
  } else {
    const r = await exec("ps", ["-axo", "pid=,ppid=,rss=,time="], { timeout: 15000 });
    for (const line of r.stdout.split("\n")) {
      const f = line.trim().split(/\s+/);
      const pid = Number(f[0]), cpu = f.length === 4 ? seconds(f[3]) : NaN;
      if (pid && !Number.isNaN(cpu)) procs.set(pid, { ppid: Number(f[1]), rss: Number(f[2]) * 1024 || 0, cpu });
    }
    const n = await exec("getconf", ["_NPROCESSORS_ONLN"]).catch(() => null);
    cores = Number(n?.stdout.trim()) || 0;
  }
  if (!procs.size) throw new Error("no processes listed");
  const children = new Map();
  for (const [pid, p] of procs) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(pid);
  }
  return { at: Date.now(), procs, children, cores };
}

let prev = null;
let cur = null;
// When the read in flight started, 0 if none. Not a promise the copies share:
// a copy's task isn't woken by a promise another copy's task settles, and a
// read stops with its pane, so each copy only ever awaits its own. The others
// take the last table meanwhile, and a read that never ends is given up on.
let readingSince = 0;
const GIVE_UP = 20000;

// The latest table, null before the first read ends.
async function table() {
  const now = Date.now();
  // Fresh by when it was asked for, not when it came back (a read takes up to
  // a second): else every other tick would find the last one still fresh.
  if ((cur && now - cur.asked < INTERVAL - 500) || now - readingSince < GIVE_UP) return cur;
  const mine = readingSince = now;
  try {
    const t = await readTable();
    t.asked = mine;
    if (!cur || t.at > cur.at) { prev = cur; cur = t; }
  } finally {
    if (readingSince === mine) readingSince = 0;
  }
  return cur;
}

// The terminal's root pid, asked once: it changes only when hc replaces a lost
// program with a shell, and then it's gone from the table.
const rootPid = new Map();

async function root(terminal, t) {
  const known = rootPid.get(terminal);
  if (known && t.procs.has(known)) return known;
  const r = await hc(["get", terminal, "--json"]);
  const pid = JSON.parse(r.stdout || "{}").pid ?? null;
  if (pid) rootPid.set(terminal, pid); else rootPid.delete(terminal);
  return pid && t.procs.has(pid) ? pid : null;
}

function tree(t, pid) {
  const pids = new Set([pid]);
  for (const p of pids) for (const c of t.children.get(p) ?? []) pids.add(c);
  return pids;
}

// { cpu, rss, count, cores }: cpu in % of one core (null until the second
// read), rss in bytes, count processes. null when the terminal's process
// can't be found, or before the first read ends.
export async function terminalStats(terminal) {
  const t = await table();
  if (!t) return null;
  // The read before t: taken now, since another read can land during the await below.
  const before = prev;
  const pid = await root(terminal, t);
  if (!pid) return null;
  const pids = tree(t, pid);
  let rss = 0, used = 0;
  for (const p of pids) {
    const now = t.procs.get(p);
    rss += now.rss;
    // A process that wasn't there last time spent all of its CPU time since.
    if (before) used += Math.max(0, now.cpu - (before.procs.get(p)?.cpu ?? 0));
  }
  const elapsed = before ? (t.at - before.at) / 1000 : 0;
  return { cpu: elapsed > 0 ? (used / elapsed) * 100 : null, rss, count: pids.size, cores: t.cores };
}

export function fmtBytes(n) {
  const mb = n / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}
