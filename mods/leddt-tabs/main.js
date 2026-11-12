import { View, div, svg, image } from "gpui-kit";
import { h_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, shared, setShared, layout, settings, knownAgents, readTextFile, appHome } from "herdr";
import { newSplitTab } from "./split.js";

// The agents each machine last reported, shared with new-menu (it writes the same key).
const KNOWN = "new-menu.agents";
// Until knownAgents() has answered, or when it lists none installed.
const FALLBACK_AGENT = { key: "claude", name: "Claude Code", icon: "icons/claude.svg", tint: false, run: ["claude"] };

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class Tabs extends View {
  init() {
    this.pressed = null;
    this.scroll = ScrollHandle.new();
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    this.checked = {}; // machine → when its agents were last asked for
    this.mods = {}; // mod → { ok, at }: whether its folder is in the Herdr home
  }

  // Whether `mod` is installed (mods/<mod>/main.js in the Herdr home). Asked once, then every
  // 30s while it's missing, so a mod added later gets its button.
  installed(cx, mod) {
    if (!mod) return false;
    const known = this.mods[mod];
    if (!known || (!known.ok && Date.now() - known.at > 30000)) {
      this.mods[mod] = { ok: known?.ok ?? false, at: Date.now() };
      cx.spawn(async cx => {
        const text = await readTextFile(`${appHome()}/mods/${mod}/main.js`).catch(() => null);
        this.mods[mod] = { ok: text != null, at: Date.now() };
        cx.notify();
      });
    }
    return this.mods[mod].ok;
  }

  // The installed agent Herdr lists first on that machine (most picked), else Claude.
  // Asks again at most once a minute per machine (Herdr caches as long).
  topAgent(cx, machine) {
    const where = machine ?? "";
    if (!(Date.now() - (this.checked[where] ?? 0) < 60000)) {
      this.checked[where] = Date.now();
      cx.spawn(async cx => {
        try {
          const list = await knownAgents({ on: machine });
          setShared(KNOWN, { ...shared(KNOWN), [where]: list });
          cx.notify();
        } catch { /* keep the last list */ }
      });
    }
    return (shared(KNOWN)?.[where] ?? []).find(a => a.installed && a.run?.length) ?? FALLBACK_AGENT;
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render(cx) {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const active = shown.findIndex(tab => tab.active);
    const selected = shown[active]?.id;
    if (selected !== this.selected || active !== this.selectedIndex) {
      this.selected = selected;
      this.selectedIndex = active;
      if (active >= 0) this.scroll.scroll_to_item(active);
    }
    const agent = this.topAgent(cx, space?.machine);
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        // A rename or status dot on this or an earlier tab can push the active one out.
        .when(i <= active, el => el.on_size_change((_size, cx) => { this.scroll.scroll_to_item(active); cx.notify(); }))
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    // The other panels come from the layout: each block of the panel-body stack whose props have
    // `panel: { label, icon }`, offered whenever its mod is installed (they aren't among the
    // welcome screen's panels).
    // The remembered panel of each space counts them all, so one isn't dropped while its check runs.
    const others = (body?.children ?? []).filter(c => c.id !== "files" && c.id !== "changes" && c.content?.props?.panel);
    const extras = others.filter(c => this.installed(cx, c.content.mod));
    const enabled = [...(shared("workspace.panels") ?? ["files", "changes"]), ...others.map(c => c.id)];
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label);
    };
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().track_scroll(this.scroll)
        .on_size_change((_size, cx) => { if (active >= 0) { this.scroll.scroll_to_item(active); cx.notify(); } })
        .children(shown.map(item)))
      .child(h_flex().flex_none().items_center().rounded(7).border(1).border_color(t.border)
        .child(button("tab-new-terminal", svg("icons/shell.svg").size(14), () => run("tab.new", { space: space?.id })).tooltip("New terminal tab (Ctrl+Shift+T)"))
        .child(button("tab-new-agent", agent.tint ? svg(agent.icon).size(14) : image(agent.icon).size(14),
          () => run("tab.new", { name: agent.name, space: space?.id, argv: agent.run })).tooltip(`New ${agent.name} tab`))
        .child(button("tab-leddt-split", svg("mods/pane/split-right.svg").size(14),
          (_e, cx) => { if (space) cx.spawn(cx => newSplitTab(cx, space.id, agent)); })
          .tooltip(`New Split Tab: ${agent.name} with a terminal beside it`))
        .child(button("tab-new", svg("mods/leddt-tabs/more.svg").size(14), () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })).tooltip("More…")))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .children(extras.map(c => panelButton(c.id, c.content.props.panel.label ?? c.id, c.content.props.panel.icon)))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/leddt-tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/leddt-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/leddt-tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
