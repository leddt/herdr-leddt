// A command line under the shown tab's panes: type a command, Enter opens a new terminal
// below the focused pane (in the tab's folder) that runs it, then stays at a shell prompt.
// Up/Down go through the commands run before; Esc clears.
import { View, div } from "gpui-kit";
import { h_flex, InputState, Input } from "gpui-base";
import { run, theme, spaces, panes, focused, exec, window, notify } from "herdr";

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
    return h_flex().id("leddt-command").size_full().px(8).pb(8).items_center()
      .on_key_down((e, cx) => {
        if (e.key === "up") { this.browse(1); cx.stop_propagation(); cx.notify(); }
        else if (e.key === "down") { this.browse(-1); cx.stop_propagation(); cx.notify(); }
        else if (e.key === "escape") { this.at = null; this.input.set_value(""); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().flex_1().h_full().min_w(0).gap(8).pl(12).pr(4).items_center().rounded(10)
        .border_1().border_color(this.focused ? t.accent : t.border).bg(t.background)
        .child(div().flex_none().text_size(13).font_semibold().text_color(this.focused ? t.accent : t.dim).child("›"))
        .child(Input.new(this.input).flex_1().min_w(0).h_full().text_size(12.8).text_color(t.foreground)));
  }
}
