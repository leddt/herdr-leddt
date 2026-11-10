// A command line under the shown tab's panes: type a command, Enter opens a new terminal
// below the focused pane (in the tab's folder) that runs it, then stays at a shell prompt.
// Up/Down go through the commands run before; Esc clears. It starts with a terminal icon and
// the folder the command will run in, then ">", so it doesn't read as an agent's prompt.
import { View, div, svg } from "gpui-kit";
import { h_flex, InputState, Input } from "gpui-base";
import { run, theme, spaces, panes, focused, exec, window, notify, home } from "herdr";

const HISTORY = 100;

// The shown tab: { space, tab }, or null.
function shownTab() {
  const space = spaces().find(s => s.active);
  const tab = space?.tabs.find(t => t.active);
  return tab ? { space, tab } : null;
}

// The pane the new terminal goes under: the focused one when it's in the shown tab, else
// the tab's first. Its folder: that pane's, or for a mod pane (none), the tab's first terminal's.
function target(tab) {
  const ps = panes().filter(p => p.tab === tab.id);
  const f = focused();
  const pane = ps.find(p => p.pane === f?.pane) ?? ps[0] ?? null;
  const cwd = (pane?.terminal && pane.cwd) || ps.find(p => p.terminal && p.cwd)?.cwd || undefined;
  return { pane, cwd };
}

// The folder as shown before the ">": the home folder as "~".
function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  if (!h) return cwd;
  if (cwd === h) return "~";
  return cwd.startsWith(h + "/") || cwd.startsWith(h + "\\") ? "~" + cwd.slice(h.length) : cwd;
}

// What runs the command: the person's shell, which stays open once the command ends.
function argv(command, local, pwsh) {
  if (local && window()?.platform === "windows") return [pwsh, "-NoLogo", "-NoExit", "-Command", command];
  return ["sh", "-c", 's="${SHELL:-/bin/sh}"; "$s" -ic "$1"; exec "$s" -i', "sh", command];
}

export default class CommandLine extends View {
  init(_props, cx) {
    this.input = InputState.new({ value: "", placeholder: "Commande à exécuter dans un nouveau terminal…" });
    this.input.on("submit", (_e, cx) => this.submit(cx));
    this.focused = false;
    this.input.on("focus", (_e, cx) => { this.focused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.focused = false; cx.notify(); });
    try { this.history = JSON.parse(localStorage.getItem("history") ?? "[]"); } catch { this.history = []; }
    this.at = null; // the history entry shown by Up/Down; null: what's being typed
    this.draft = "";
    // PowerShell 7 when it's installed, as Herdr's own shells; else Windows PowerShell.
    this.pwsh = "powershell";
    if (window()?.platform === "windows") {
      cx.spawn(async () => {
        try { if ((await exec("where", ["pwsh"])).code === 0) this.pwsh = "pwsh"; } catch {}
      });
    }
  }

  submit(cx) {
    const command = this.input.value().trim();
    if (!command) return;
    const shown = shownTab();
    if (!shown) { notify({ title: "Aucun onglet affiché", level: "warning" }); return; }
    const { pane, cwd } = target(shown.tab);
    if (pane) run("pane.focus", { pane: pane.pane });
    run("terminal.open", {
      argv: argv(command, !shown.space.machine, this.pwsh),
      folder: cwd,
      place: pane ? "down" : "tab",
      name: command.length > 40 ? command.slice(0, 39) + "…" : command,
    });
    this.history = [command, ...this.history.filter(c => c !== command)].slice(0, HISTORY);
    localStorage.setItem("history", JSON.stringify(this.history));
    this.at = null;
    this.draft = "";
    this.input.set_value("");
    cx.notify();
  }

  // Up: an older command; Down: a newer one, then back to what was being typed.
  browse(step) {
    if (!this.history.length) return;
    if (this.at === null) this.draft = this.input.value();
    const next = (this.at ?? -1) + step;
    if (next < 0) { this.at = null; this.input.set_value(this.draft); return; }
    this.at = Math.min(next, this.history.length - 1);
    this.input.set_value(this.history[this.at]);
  }

  render() {
    const t = theme();
    const shown = shownTab();
    const where = shown ? folder(target(shown.tab).cwd) : "";
    const color = this.focused ? t.accent : t.dim;
    return h_flex().id("leddt-command").size_full().items_center()
      .on_key_down((e, cx) => {
        if (e.key === "up") { this.browse(1); cx.stop_propagation(); cx.notify(); }
        else if (e.key === "down") { this.browse(-1); cx.stop_propagation(); cx.notify(); }
        else if (e.key === "escape") { this.at = null; this.input.set_value(""); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().flex_1().h_full().min_w(0).gap(6).pl(8).pr(2).items_center()
        .border_t_1().border_color(this.focused ? t.accent : t.border).bg(t.background)
        .child(svg("mods/workspace-chrome/terminal.svg").size(14).flex_none().text_color(color))
        .child(h_flex().flex_none().max_w(320).min_w(0).gap(4).items_center().text_size(12.8).text_color(color)
          .when(!!where, el => el.child(div().min_w(0).truncate().child(where)))
          .child(div().flex_none().font_semibold().child(">")))
        .child(Input.new(this.input).flex_1().min_w(0).h_full().text_size(12.8).text_color(t.foreground)));
  }
}
