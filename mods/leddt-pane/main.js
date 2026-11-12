// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "leddt-pane" } } } }
// Shows the program's icon (the app's program table), the agent's name or
// the terminal's title, the folder, and the agent's status; buttons split, zoom and close
// this pane. Props from the app: { pane, terminal }. Click: focus the pane.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, spaces, props, run, theme, home, hc, exec, readTextFile, notify, openOverlay, shared, setShared, window } from "herdr";
import { readContext, contextColor, fmtTokens } from "./context.js";
import { review } from "./review.js";
import { terminalStats, fmtBytes, INTERVAL } from "./stats.js";

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

const platform = () => window().platform;

// Direct children of these pids, one per line. No pgrep on Windows: ask WMI.
function childPids(pids) {
  if (platform() === "windows") {
    const filter = pids.map((p) => `ParentProcessId=${p}`).join(" OR ");
    return exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object ProcessId`]);
  }
  return exec("pgrep", ["-P", pids.join(",")]);
}

async function sessionAt(pid) {
  const text = await readTextFile(`${home()}/.claude/sessions/${pid}.json`);
  try { return text ? JSON.parse(text).sessionId ?? null : null; } catch { return null; }
}

// Claude's pid per terminal, so the 5 s refresh reads one file instead of
// walking processes (a PowerShell start on Windows) every time.
const claudePid = new Map();

// The Claude Code session running in a terminal: its foreground process's pid
// names ~/.claude/sessions/<pid>.json, which holds the sessionId.
async function claudeSession(terminal) {
  const known = claudePid.get(terminal);
  if (known) {
    const id = await sessionAt(known);
    if (id) return id;
    claudePid.delete(terminal);
  }
  const r = await hc(["get", terminal, "--json"]);
  const t = JSON.parse(r.stdout || "{}");
  // Claude often runs under a shell wrapper (fish -c 'command claude', or the
  // pwsh that's the terminal's foreground on Windows), so also try the
  // terminal's descendants, a few levels down.
  const pids = [...new Set([t.foreground?.pid, t.pid].filter(Boolean))];
  for (let i = 0, level = pids.slice(); i < 3 && level.length; i++) {
    const r = await childPids(level).catch(() => null);
    level = (r?.stdout ?? "").split(/\r?\n/).map(Number).filter((n) => n && !pids.includes(n));
    pids.push(...level);
  }
  for (const pid of pids) {
    const id = await sessionAt(pid);
    if (id) { claudePid.set(terminal, pid); return id; }
  }
  return null;
}

function openUrl(url) {
  const p = platform();
  if (p === "windows") return exec("explorer.exe", [url]);
  return exec(p === "macos" ? "open" : "xdg-open", [url]);
}

async function openInDesktop(terminal) {
  try {
    const id = await claudeSession(terminal);
    if (!id) {
      notify({ title: "No Claude session found", body: `Couldn't find the session running in ${terminal}.`, level: "warning" });
      return;
    }
    await openUrl(`claude://resume?session=${id}`);
  } catch (e) {
    notify({ title: "Couldn't open Claude Desktop", body: String(e?.message ?? e), level: "error" });
  }
}

export default class Pane extends View {
  init(_props, cx) {
    this.hovered = false;
    this.refreshContext(cx);
    cx.timer.every(5000, (cx) => this.refreshContext(cx));
    this.refreshStats(cx);
    cx.timer.every(INTERVAL, (cx) => this.refreshStats(cx));
  }

  // CPU and memory of this pane's terminal (stats.js). Only while its tab is
  // the one on screen, and on this machine: timers also run in hidden tabs.
  refreshStats(cx) {
    const p = this.me();
    const space = spaces().find((s) => s.tabs?.some((tb) => tb.id === p?.tab));
    const shown = space?.active && space.tabs.find((tb) => tb.id === p.tab)?.active;
    // A sample that never ended doesn't hold the next ones back forever.
    const busy = this.sampling && Date.now() - this.sampling < 30000;
    if (!p?.terminal || !shown || space.machine || busy) return;
    const mine = this.sampling = Date.now();
    cx.spawn(async (cx) => {
      try {
        this.stats = await terminalStats(p.terminal);
        this.statsAt = Date.now();
      } catch { this.stats = null; }
      if (this.sampling === mine) this.sampling = 0;
      cx.notify();
    });
  }

  statsChip(t, terminal) {
    const s = this.stats;
    // Not the numbers from before its tab was hidden.
    if (!s || Date.now() - this.statsAt > INTERVAL * 3) return null;
    const cpu = s.cpu === null ? null : Math.round(s.cpu);
    const tip = [
      cpu === null ? null : `CPU: ${cpu}% of one core` + (s.cores ? ` (${Math.round(s.cpu / s.cores)}% of ${s.cores})` : ""),
      `Memory: ${fmtBytes(s.rss)}`,
      s.count === 1 ? "1 process" : `${s.count} processes`,
    ].filter(Boolean).join(" · ");
    return h_flex()
      .id(`ph-stats-${terminal}`)
      .flex_none()
      .gap(6)
      .items_center()
      .text_size(11)
      .text_color(t.dim)
      .tooltip(tip)
      .when(cpu !== null, (el) => el.child(div().text_color(cpu >= 50 ? t.foreground : t.dim).child(`${cpu}%`)))
      .child(div().child(fmtBytes(s.rss)));
  }

  // Context usage of the Claude session in this pane, shared as
  // "leddt-context:<terminal>" so the popover follows it live.
  refreshContext(cx) {
    const p = this.me();
    const local = !spaces().find((s) => s.tabs?.some((tb) => tb.id === p?.tab))?.machine;
    if (!p?.terminal || !local || !(p.program?.key === "claude" || p.app === "claude-code") || this.reading) return;
    this.reading = true;
    cx.spawn(async (cx) => {
      try {
        const sid = await claudeSession(p.terminal);
        const ctx = sid ? await readContext(sid) : null;
        const key = `leddt-context:${p.terminal}`;
        if (JSON.stringify(shared(key) ?? null) !== JSON.stringify(ctx)) setShared(key, ctx);
      } catch {}
      this.reading = false;
      cx.notify();
    });
  }

  contextChip(t, terminal) {
    const c = shared(`leddt-context:${terminal}`);
    if (!c) return null;
    const pct = Math.min(100, Math.round((c.total / c.window) * 100));
    const color = contextColor(t, pct);
    return h_flex()
      .id(`ph-ctx-${terminal}`)
      .flex_none()
      .h(20)
      .px(6)
      .gap(6)
      .items_center()
      .rounded(5)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .tooltip(`Context: ${fmtTokens(c.total)} of ${fmtTokens(c.window)} tokens`)
      .on_click((_e, cx) => {
        cx.stop_propagation();
        // Size per the popover's mode (keep in sync with leddt-context's SIZES).
        const size = shared("leddt-context.mode") === "detailed" ? { width: 320, height: 540 } : { width: 280, height: 340 };
        openOverlay({ mod: "leddt-context", kind: "popup", ...size, props: { terminal } });
      })
      .child(div().w(28).h(4).rounded(2).bg(t.raised)
        .child(div().h_full().rounded(2).bg(color).w(`${Math.max(pct, 3)}%`).transition("width", 400)))
      .child(div().text_size(11).text_color(pct >= 70 ? color : t.dim).child(`${pct}%`));
  }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  button(t, id, icon, command, args) {
    return this.action(t, id, icon, () => run(command, args));
  }

  action(t, id, icon, fn) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        fn();
      })
      .child(svg(`mods/leddt-pane/${icon}.svg`).size(14));
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const name = p.mod === "leddt-review" ? "Review" : ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    const machine = spaces().find((s) => s.tabs?.some((tb) => tb.id === p.tab))?.machine ?? null;
    const claude = p.terminal && (p.program?.key === "claude" || p.app === "claude-code");
    const isClaude = claude && !machine;
    // A mod pane (Findings) has no folder: its tab's first terminal's, shown
    // and used for its splits (a plain pane.split would start in the space's folder).
    const mateCwd = p.mod ? panes().find((x) => x.tab === p.tab && x.terminal && x.cwd)?.cwd ?? null : null;
    const split = (direction) => mateCwd
      ? this.action(t, `ph-${direction[0]}-${pane}`, `split-${direction}`, () => {
          run("pane.focus", { pane });
          run("terminal.open", { place: direction, folder: mateCwd });
        })
      : this.button(t, `ph-${direction[0]}-${pane}`, `split-${direction}`, "pane.split", { direction, pane });
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .border_b(1)
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd || mateCwd)))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      // Review: pick a base branch, then a fresh reviewer runs /code-review and a Findings pane opens (leddt-review).
      .when(this.hovered && isClaude && Boolean(p.cwd), el => el.child(
        h_flex()
          .id(`ph-review-${pane}`)
          .flex_none()
          .h(20)
          .px(6)
          .gap(4)
          .items_center()
          .rounded(4)
          .text_size(11.5)
          .text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Review this branch (reopens its last review; Shift+click: a new one)")
          .on_click((e, cx) => {
            cx.stop_propagation();
            const fresh = !!e.modifiers?.shift;
            cx.spawn(async (cx) => review(cx, p, fresh));
          })
          .child(svg("mods/leddt-review/git-compare.svg").size(13))
          .child("Review")))
      // Done: archive this Claude session (resumable with /resume) and start a fresh one in place.
      .when(this.hovered && claude, el => el.child(
        div()
          .id(`ph-done-${pane}`)
          .p(3)
          .rounded(4)
          .text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Done: archive this session, start a fresh one")
          .on_click((_e, cx) => {
            cx.stop_propagation();
            cx.spawn(async () => {
              const res = await hc(["keys", p.terminal, "/", "c", "l", "e", "a", "r", "enter"]);
              if (res.code !== 0) notify({ title: "Couldn't start a fresh session", body: (res.stderr || res.stdout).trim(), level: "error" });
            });
          })
          .child(svg("mods/workspace-chrome/check.svg").size(14))))
      .when(this.hovered && isClaude, el => el.child(
        div()
          .id(`ph-cd-${pane}`)
          .p(3)
          .rounded(4)
          .text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Open this session in Claude Desktop")
          .on_click((_e, cx) => {
            cx.stop_propagation();
            cx.spawn(async () => openInDesktop(p.terminal));
          })
          .child(svg("mods/leddt-pane/open-desktop.svg").size(14))))
      .when(this.hovered, el => el
        .child(split("right"))
        .child(split("down"))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })))
      // Last, at the right edge: the hover buttons appear to their left, so they never move.
      .when(Boolean(p.terminal && !machine), (el) => { const chip = this.statsChip(t, p.terminal); return chip ? el.child(chip) : el; })
      .when(Boolean(isClaude), (el) => { const chip = this.contextChip(t, p.terminal); return chip ? el.child(chip) : el; });
  }
}
