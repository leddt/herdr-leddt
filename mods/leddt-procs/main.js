// Popover with the processes running in a terminal, opened from the CPU/memory
// chip in leddt-pane's header. Props: { terminal, name, overlay }.
//
// The terminal's root process (hc's `pid`) and its descendants, each with its
// CPU (% of one core, between two reads) and resident memory, read every
// INTERVAL while the popover is open. Two views (shared "leddt-procs.view",
// remembered): "tree" (parents above children) and "top" (flat, by CPU).
//
// Linux reads /proc/<pid>/stat: CPU time in clock ticks, where ps only gives
// whole seconds (too coarse for a 2 s interval). Elsewhere ps (macOS: 1/100 s)
// or WMI (Windows).
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, shared, setShared, theme, hc, exec, home, window } from "herdr";

const VIEW = "leddt-procs.view";
const INTERVAL = 2000;
// The first CPU numbers need two reads: the second comes sooner.
const FIRST = 800;
const ROW = 22;
const MAX_ROWS = 12;

const platform = () => window().platform;

// Once per process (module code is shared by copies).
let sys = null;
async function system() {
  if (sys) return sys;
  const conf = async (name, def) => Number((await exec("getconf", [name]).catch(() => null))?.stdout.trim()) || def;
  if (platform() === "windows") sys = { cores: 0, tick: 1, page: 1 };
  else sys = { cores: await conf("_NPROCESSORS_ONLN", 0), tick: await conf("CLK_TCK", 100), page: await conf("PAGESIZE", 4096) };
  return sys;
}

// ps prints CPU time as [dd-]hh:mm:ss (Linux) or mm:ss.cc (macOS).
function seconds(time) {
  const [rest, days] = time.split("-").reverse();
  return rest.split(":").reduce((s, part) => s * 60 + Number(part), 0) + (Number(days) || 0) * 86400;
}

const base = (cmd) => (cmd.split(/\s+/)[0] ?? "").split(/[\\/]/).pop() || cmd;

// Map pid -> { ppid, name, rss (bytes), cpu (s), start }. `start` tells a
// reused pid apart from the process that had it last time.
async function readLinux(s) {
  const r = await exec("sh", ["-c", "cat /proc/[0-9]*/stat 2>/dev/null"], { timeout: 10000 });
  const procs = new Map();
  for (const line of r.stdout.split("\n")) {
    // pid (comm) state ppid ...: comm can hold spaces and parentheses.
    const open = line.indexOf(" ("), close = line.lastIndexOf(")");
    if (open < 0 || close < 0) continue;
    const pid = Number(line.slice(0, open));
    const f = line.slice(close + 2).split(" ");
    if (!pid || f.length < 22) continue;
    procs.set(pid, {
      ppid: Number(f[1]),
      name: line.slice(open + 2, close),
      cpu: (Number(f[11]) + Number(f[12])) / s.tick,
      start: f[19],
      rss: Number(f[21]) * s.page,
    });
  }
  return procs;
}

async function readPs() {
  const r = await exec("ps", ["-axo", "pid=,ppid=,rss=,time=,args="], { timeout: 10000 });
  const procs = new Map();
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    procs.set(Number(m[1]), { ppid: Number(m[2]), rss: Number(m[3]) * 1024, cpu: seconds(m[4]), name: base(m[5]), args: m[5], start: "" });
  }
  return procs;
}

const WINDOWS = "'cores ' + $env:NUMBER_OF_PROCESSORS; "
  + "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime,Name,CommandLine,CreationDate | "
  // [char]9: a tab ("`t" is literal in the single quotes the -f format would need).
  + "ForEach-Object { ($_.ProcessId, $_.ParentProcessId, $_.WorkingSetSize, "
  + "(($_.KernelModeTime + $_.UserModeTime) / 1e7), $_.Name, $_.CreationDate.Ticks, ($_.CommandLine -replace '\\s+', ' ')) -join [char]9 }";

async function readWindows(s) {
  const r = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS], { timeout: 15000 });
  const procs = new Map();
  for (const line of r.stdout.split(/\r?\n/)) {
    if (line.startsWith("cores ")) { s.cores = Number(line.slice(6)) || 0; continue; }
    const f = line.split("\t");
    const pid = Number(f[0]);
    // The decimal separator follows the system's culture.
    const cpu = Number((f[3] ?? "").replace(",", "."));
    if (!pid || f.length < 7 || Number.isNaN(cpu)) continue;
    procs.set(pid, { ppid: Number(f[1]), rss: Number(f[2]) || 0, cpu, name: f[4], start: f[5], args: f[6] || f[4] });
  }
  return procs;
}

// Full command lines for a few pids (Linux: the stat file only has the name).
async function argsLinux(pids) {
  const r = await exec("ps", ["-o", "pid=,args=", "-p", pids.join(",")], { timeout: 5000 }).catch(() => null);
  const out = new Map();
  for (const line of (r?.stdout ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m) out.set(Number(m[1]), m[2]);
  }
  return out;
}

function fmtBytes(n) {
  const mb = n / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

function fmtCpu(c) {
  if (c == null) return "…";
  return c >= 10 ? `${Math.round(c)}%` : `${c.toFixed(1)}%`;
}

export default class Procs extends View {
  init(_props, cx) {
    this.prev = null;     // { at, procs }
    this.rows = null;     // [{ pid, depth, name, args, cpu, rss }]
    this.rootPid = null;
    this.err = null;
    this.reading = 0;
    this.readAt = 0;
    this.args = new Map(); // pid:start -> command line
    this.read(cx);
    cx.timer.every(200, (cx) => {
      const every = this.prev && this.rows?.some((r) => r.cpu != null) ? INTERVAL : FIRST;
      if (!this.reading && Date.now() - this.readAt >= every) this.read(cx);
    });
  }

  view() { return shared(VIEW) === "top" ? "top" : "tree"; }

  read(cx) {
    const terminal = props()?.terminal;
    if (!terminal) return;
    this.reading = this.readAt = Date.now();
    cx.spawn(async (cx) => {
      try {
        const s = await system();
        const os = platform();
        const procs = os === "linux" ? await readLinux(s) : os === "windows" ? await readWindows(s) : await readPs();
        const at = Date.now();
        if (!procs.size) throw new Error("No processes listed.");
        if (!this.rootPid || !procs.has(this.rootPid)) {
          const r = await hc(["get", terminal, "--json"]);
          this.rootPid = JSON.parse(r.stdout || "{}").pid ?? null;
        }
        if (!this.rootPid || !procs.has(this.rootPid)) throw new Error("This terminal's process isn't running here.");

        const children = new Map();
        for (const [pid, p] of procs) {
          if (!children.has(p.ppid)) children.set(p.ppid, []);
          children.get(p.ppid).push(pid);
        }
        const before = this.prev;
        const elapsed = before ? (at - before.at) / 1000 : 0;
        const rows = [];
        const walk = (pid, depth) => {
          const p = procs.get(pid);
          const old = before?.procs.get(pid);
          // A process that wasn't there last time spent all of its CPU time since.
          const used = old && old.start === p.start ? p.cpu - old.cpu : p.cpu;
          rows.push({ pid, depth, name: p.name, args: p.args, start: p.start, rss: p.rss,
            cpu: elapsed > 0 ? Math.max(0, used / elapsed * 100) : null });
          for (const c of (children.get(pid) ?? []).sort((a, b) => a - b)) walk(c, depth + 1);
        };
        walk(this.rootPid, 0);

        if (os === "linux") {
          const missing = rows.filter((r) => !this.args.has(`${r.pid}:${r.start}`)).map((r) => r.pid);
          if (missing.length) for (const [pid, a] of await argsLinux(missing)) this.args.set(`${pid}:${procs.get(pid)?.start}`, a);
          for (const r of rows) r.args = this.args.get(`${r.pid}:${r.start}`) ?? r.name;
          // Forget processes that ended.
          if (this.args.size > rows.length * 4) {
            const live = new Set(rows.map((r) => `${r.pid}:${r.start}`));
            for (const k of this.args.keys()) if (!live.has(k)) this.args.delete(k);
          }
        }

        this.prev = { at, procs };
        this.rows = rows;
        this.cores = s.cores;
        this.err = null;
      } catch (e) {
        this.err = String(e?.message ?? e).split("\n")[0];
      }
      this.reading = 0;
      cx.notify();
    });
  }

  toggle(t, view) {
    const seg = (v, label) => div().id(`lp-view-${v}`).px(8).h(20).flex().items_center().rounded(4)
      .text_size(11).cursor_pointer()
      .when(v === view, (el) => el.bg(t.selected).text_color(t.foreground).font_medium())
      .when(v !== view, (el) => el.text_color(t.dim).hover((s) => s.text_color(t.foreground)))
      .on_click((_e, cx) => { setShared(VIEW, v); cx.notify(); })
      .child(label);
    return h_flex().p(2).gap(2).rounded(6).bg(t.raised).flex_none()
      .child(seg("tree", "Tree")).child(seg("top", "By CPU"));
  }

  render(cx) {
    const t = theme();
    const p = props() ?? {};
    const view = this.view();
    const rows = this.rows;
    const header = h_flex().items_center().gap(8).flex_none()
      .child(v_flex().flex_1().min_w(0)
        .child(div().text_size(13.5).font_semibold().child("Processes"))
        .when(!!p.name, (el) => el.child(div().text_size(11).text_color(t.dim).truncate().child(p.name))))
      .child(this.toggle(t, view));
    const root = v_flex().id("leddt-procs").w_full().p(14).gap(10).bg(t.popover).text_color(t.foreground).child(header);

    if (!rows) {
      return root.child(div().text_size(12).text_color(this.err ? t.blocked : t.dim)
        .when(!this.err, (el) => el.frames(["Reading processes", "Reading processes.", "Reading processes..", "Reading processes..."], 300))
        .when(!!this.err, (el) => el.child(this.err)));
    }

    const hasCpu = rows.some((r) => r.cpu != null);
    const cpu = hasCpu ? rows.reduce((s, r) => s + (r.cpu ?? 0), 0) : null;
    const rss = rows.reduce((s, r) => s + r.rss, 0);
    const list = view === "top"
      ? rows.slice().sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0) || b.rss - a.rss)
      : rows;
    const h = home();
    const tidy = (a) => (a ?? "").split(h + "/").join("~/");

    const stat = (label, value, sub) => v_flex().gap(1)
      .child(div().text_size(10.5).text_color(t.dim).child(label))
      .child(h_flex().items_end().gap(4)
        .child(div().text_size(15).font_semibold().child(value))
        .when(!!sub, (el) => el.child(div().pb(2).text_size(10.5).text_color(t.dim).child(sub))));

    const col = (w) => div().w(w).flex_none().text_right();
    const row = (r) => {
      const hot = (r.cpu ?? 0) >= 50;
      return h_flex().id(`lp-${r.pid}-${r.start}`).items_center().gap(8).h(ROW).flex_none().px(4).rounded(4).text_size(12)
        .hover((s) => s.bg(t.hover))
        .tooltip(`${r.pid} · ${tidy(r.args) || r.name}`)
        .child(h_flex().flex_1().min_w(0).items_center().gap(6)
          .when(view === "tree", (el) => el.pl(r.depth * 12))
          .child(div().flex_none().text_color(t.foreground).child(r.name))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim)
            .child(tidy(r.args && r.args !== r.name ? r.args.replace(/^\S+\s*/, "") : ""))))
        .child(col(52).text_color(hot ? t.blocked : (r.cpu ?? 0) >= 5 ? t.foreground : t.dim).child(fmtCpu(r.cpu)))
        .child(col(64).text_color(t.muted).child(fmtBytes(r.rss)));
    };

    return root
      .child(h_flex().gap(20).flex_none()
        .child(stat("CPU", fmtCpu(cpu), cpu != null && this.cores ? `${Math.round(cpu / this.cores)}% of ${this.cores} cores` : null))
        .child(stat("Memory", fmtBytes(rss)))
        .child(stat("Processes", String(rows.length))))
      .child(div().h(1).bg(t.border).flex_none())
      .child(h_flex().gap(8).px(4).flex_none().text_size(10.5).text_color(t.dim)
        .child(div().flex_1().child("Process"))
        .child(col(52).child("CPU"))
        .child(col(64).child("Memory")))
      // An explicit height: the popup is as tall as its content, so a flex_1 list gets nothing.
      // Up to MAX_ROWS rows, then it scrolls.
      .child(div().flex_none().h(Math.max(1, Math.min(list.length, MAX_ROWS)) * ROW).relative()
        .child(v_flex().id("lp-list").absolute().inset_0().overflow_y_scroll().children(list.map(row))))
      .child(div().flex_none().text_size(10.5).text_color(this.err ? t.blocked : t.dim)
        .child(this.err ? `Stale: ${this.err}` : `CPU in % of one core · every ${INTERVAL / 1000} s`));
  }
}
