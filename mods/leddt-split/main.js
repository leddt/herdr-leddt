// Asks for a tab name, then opens a new tab with the most used agent on the left
// and a shell split to its right. Opened as a dialog by leddt-tabs's
// "New Split Tab" button. Props: { space, overlay }. Enter creates, Esc cancels.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, panes, focused, knownAgents, notify } from "herdr";

// Where the space is now: the focused pane's live folder when focus is in this
// space (for a mod pane, which has none, its tab's first terminal's), else the
// space's first terminal's, else the folder the space was made in.
function spaceFolder(space) {
  const f = focused(), ps = panes();
  if (f?.space === space.id) {
    const pane = f.pane ? ps.find(p => p.pane === f.pane) : null;
    if (pane?.mod) {
      const mate = ps.find(p => p.tab === pane.tab && p.terminal && p.cwd);
      if (mate) return mate.cwd;
    } else if (f.cwd) return f.cwd;
  }
  const tabIds = new Set(space.tabs.map(t => t.id));
  const first = ps.find(p => tabIds.has(p.tab) && p.terminal && p.cwd);
  return first?.cwd || space.folder || undefined;
}

// The agent installed on that machine that Herdr lists first (most picked), else Claude.
async function topAgent(machine) {
  try {
    const top = (await knownAgents({ on: machine })).find(a => a.installed && a.run?.length);
    if (top) return top;
  } catch {}
  return { key: "claude", name: "Claude Code", icon: "icons/claude.svg", tint: false, run: ["claude"] };
}

async function newSplitTab(cx, spaceId, name) {
  const space = spaces().find(s => s.id === spaceId);
  if (!space) return;
  const agent = await topAgent(space.machine);
  const argv = agent.run;
  const folder = spaceFolder(space);
  const before = new Set(space.tabs.map(t => t.id));
  run("tab.new", { name, space: space.id, argv, folder });
  for (let i = 0; i < 60; i++) {
    const tab = spaces().find(s => s.id === space.id)?.tabs.find(t => !before.has(t.id));
    const pane = tab && panes().find(p => p.tab === tab.id);
    if (pane) {
      // pane.split takes no folder: focus the agent pane, then open the shell to its right.
      run("pane.focus", { pane: pane.pane });
      run("terminal.open", { place: "right", folder });
      return;
    }
    await cx.sleep(50);
  }
  notify({ title: `Couldn't split the new ${agent.name} tab`, body: "The new tab didn't appear in time.", level: "warning" });
}

export default class SplitTab extends View {
  init(_props, cx) {
    this.text = "";
    this.input = InputState.new({ value: "", placeholder: "Optional (blank: unnamed)" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.submit(cx));
    this.inputFocused = true;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
  }

  submit(cx) {
    if (this.started) return;
    this.started = true;
    const p = props();
    const name = this.text.trim() || undefined; // blank: an unnamed tab (its number)
    // Run the creation before closing: closing ends this copy and its tasks.
    cx.spawn(async (cx) => {
      try { await newSplitTab(cx, p.space, name); }
      finally { closeOverlay(p.overlay); }
    });
  }

  render() {
    const t = theme();
    const p = props() ?? {};
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover(s => s.opacity(0.88)).on_click(action).child(text);
    return v_flex().id("leddt-split").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(p.overlay); cx.stop_propagation(); } })
      .w_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child("New Split Tab"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().pt(16).pb(7).text_size(11.5).text_color(t.dim).child("Tab name"))
      .child(Input.new(this.input).h(36).px(10).rounded(9).border_1().border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_size(12.8).text_color(t.foreground))
      .child(h_flex().pt(20).gap(8).justify_end()
        .child(button("cs-cancel", "Cancel", false, () => closeOverlay(p.overlay)))
        .child(button("cs-create", "Create", true, (_e, cx) => this.submit(cx))));
  }
}
