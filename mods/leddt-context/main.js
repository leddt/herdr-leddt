// Popover with a Claude session's context usage, opened from the context chip
// in leddt-pane's header. Props: { terminal, overlay }. Follows the header's
// shared "leddt-context:<terminal>" value live.
//
// Two modes (shared "leddt-context.mode", remembered): "simple" reads the
// transcript's last usage (from the header); "detailed" runs Claude Code's own
// /context on a forked, unsaved copy of the session (no API call, ~1 s) and
// shows its breakdown by category, refreshed after each step.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, shared, setShared, theme, closeOverlay, openOverlay, hc, exec, home, notify } from "herdr";

const MODE = "leddt-context.mode";
// Keep in sync with leddt-pane, which opens the popover at the mode's size.
const SIZES = { simple: { width: 280, height: 340 }, detailed: { width: 320, height: 540 } };

// Compact token counts: 950, 12.3k, 182k, 1.25M (trailing zeros dropped).
function fmt(n) {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${+(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}
const pctText = (n, total) => (total ? `${(n / total * 100).toFixed(1)}%` : "");

// "2.8k" / "1m" / "484" / "~40" / "< 20" -> number (null when not a count).
function num(s) {
  const m = /^[~<\s]*([\d.]+)\s*([km])?$/i.exec(String(s).replace(/,/g, "").trim());
  if (!m) return null;
  const unit = (m[2] ?? "").toLowerCase();
  return Math.round(+m[1] * (unit === "m" ? 1e6 : unit === "k" ? 1e3 : 1));
}

// Parses /context's markdown: model, "Tokens: used / window", then each
// "### Section" table. The first section is the category breakdown; the others
// (Memory Files, Skills, MCP tools, agents...) list what's in a category.
function parseContext(md) {
  const out = { model: null, used: null, window: null, categories: [], sections: [] };
  out.model = /\*\*Model:\*\*\s*(\S+)/.exec(md)?.[1] ?? null;
  const tm = /\*\*Tokens:\*\*\s*([\d.]+\s*[km]?)\s*\/\s*([\d.]+\s*[km]?)/i.exec(md);
  if (tm) { out.used = num(tm[1]); out.window = num(tm[2]); }
  let cur = null;
  for (const line of md.split("\n")) {
    const h = /^###\s+(.*)/.exec(line);
    if (h) { cur = { title: h[1].trim(), header: null, rows: [] }; out.sections.push(cur); continue; }
    if (!cur || !line.trim().startsWith("|")) continue;
    const cells = line.trim().split("|").slice(1, -1).map((s) => s.trim());
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    if (!cur.header) { cur.header = cells; continue; }
    cur.rows.push(cells);
  }
  const cat = out.sections.findIndex((s) => /by category/i.test(s.title));
  if (cat >= 0) {
    out.categories = out.sections[cat].rows.map(([name, tokens]) => ({ name, tokens: num(tokens) ?? 0 }));
    out.sections.splice(cat, 1);
  }
  out.sections = out.sections.filter((s) => s.rows.length).map((s) => {
    const hdr = (s.header ?? []).map((c) => c.toLowerCase());
    const pathCol = hdr.indexOf("path");
    const h = home();
    return {
      title: s.title,
      rows: s.rows.map((cells) => {
        const tokens = cells[cells.length - 1];
        let label = pathCol >= 0 ? cells[pathCol] : cells[0];
        if (label.startsWith(h + "/")) label = "~" + label.slice(h.length);
        const sub = cells.slice(0, -1).filter((_, i) => i !== (pathCol >= 0 ? pathCol : 0)).join(" · ");
        return { label, sub, tokens: num(tokens), raw: tokens };
      }),
    };
  });
  return out;
}

// Categories not counted in the window (/context lists them, Desktop shows "—").
const outside = (name) => /deferred/i.test(name);

function categoryColor(t, name) {
  const n = name.toLowerCase();
  if (n.startsWith("messages")) return t.ansi4;
  if (n.startsWith("system tools")) return t.ansi1;
  if (n.startsWith("system prompt")) return t.ansi3;
  if (n.startsWith("skills")) return t.ansi6;
  if (n.startsWith("memory")) return t.ansi5;
  if (n.startsWith("mcp")) return t.ansi2;
  if (n.includes("agent")) return t.ansi12;
  if (n.includes("autocompact")) return t.dim;
  if (n.startsWith("free")) return t.raised;
  return t.ansi13;
}

export default class ClaudeContext extends View {
  init() {
    this.open = {};      // expanded sections, by title
    this.detail = null;  // parsed /context
    this.detailAt = undefined;
    this.loading = false;
    this.err = null;
    this.origin = null;  // this popover's top-left in the window, for reopening in place
  }

  mode() { return shared(MODE) === "detailed" ? "detailed" : "simple"; }

  // Popups can't resize: reopen at the new mode's size, where this one is.
  setMode(m) {
    if (m === this.mode()) return;
    setShared(MODE, m);
    const p = props() ?? {};
    openOverlay({ mod: "leddt-context", kind: "popup", ...SIZES[m], at: this.origin ?? "pointer", props: { terminal: p.terminal } });
    closeOverlay(p.overlay);
  }

  fetchDetail(cx, c) {
    this.loading = true;
    this.err = null;
    const at = c.at;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("claude", ["-p", "/context", "--resume", c.sessionId, "--fork-session",
          "--no-session-persistence", "--output-format", "json"], { cwd: c.cwd ?? home() });
        // c.cwd: the session's folder, where Claude Code finds CLAUDE.md and memory.
        let j;
        try { j = JSON.parse(r.stdout); } catch { throw new Error((r.stderr || r.stdout || `claude exited ${r.code}`).trim()); }
        if (j.is_error || typeof j.result !== "string") throw new Error(j.result || "claude reported an error");
        const d = parseContext(j.result);
        if (!d.categories.length) throw new Error("Couldn't read /context's output.");
        this.detail = d;
      } catch (e) {
        this.err = String(e?.message ?? e).split("\n")[0];
      }
      this.detailAt = at;
      this.loading = false;
      cx.notify();
    });
  }

  row(t, label, value) {
    return h_flex().justify_between().text_size(12)
      .child(div().text_color(t.muted).child(label))
      .child(div().text_color(t.foreground).child(value));
  }

  toggle(t, mode) {
    const seg = (m, label) => div().id(`cc-mode-${m}`).px(8).h(20).flex().items_center().rounded(4)
      .text_size(11).cursor_pointer()
      .when(m === mode, (el) => el.bg(t.selected).text_color(t.foreground).font_medium())
      .when(m !== mode, (el) => el.text_color(t.dim).hover((s) => s.text_color(t.foreground)))
      .on_click(() => this.setMode(m))
      .child(label);
    return h_flex().p(2).gap(2).rounded(6).bg(t.raised).flex_none()
      .child(seg("simple", "Simple")).child(seg("detailed", "Detailed"));
  }

  header(t, mode, model) {
    // The model gets its own line under the title, so it never truncates.
    return v_flex().gap(2).flex_none()
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().text_size(13.5).font_semibold().child("Context"))
        .child(this.toggle(t, mode)))
      .when(!!model, (el) => el.child(div().text_size(11).text_color(t.dim).child(model)));
  }

  compactButton(t, p) {
    return h_flex().justify_end().flex_none()
      .child(div().id("cc-compact").px(10).h(26).flex().items_center().rounded(6).cursor_pointer()
        .border_1().border_color(t.input).bg(t.raised).text_size(11.5).font_medium()
        .text_color(t.foreground).hover((s) => s.opacity(0.88))
        .on_click((_e, cx) => {
          // Types /compact into the session, as if the person did. Close
          // afterwards: closing the popover ends this copy and its tasks.
          cx.spawn(async () => {
            try {
              const r = await hc(["keys", p.terminal, ..."/compact", "enter"]);
              if (r.code !== 0) notify({ title: "Couldn't compact", body: (r.stderr || r.stdout).trim(), level: "error" });
            } finally { closeOverlay(p.overlay); }
          });
        })
        .child("Compact now"));
  }

  render(cx) {
    const t = theme();
    const p = props() ?? {};
    const c = shared(`leddt-context:${p.terminal}`);
    const mode = this.mode();
    const root = v_flex().id("leddt-context").size_full().p(14).gap(10).bg(t.popover).text_color(t.foreground)
      .on_mouse_move((e) => { this.origin = { x: e.position.x - e.local_position.x, y: e.position.y - e.local_position.y }; });
    if (!c) return root.child(this.header(t, mode, null))
      .child(div().text_size(12).text_color(t.dim).child("No context data for this session yet."));
    return mode === "detailed" ? this.renderDetailed(cx, t, p, c, root) : this.renderSimple(t, p, c, root);
  }

  renderSimple(t, p, c, root) {
    const pct = Math.min(100, (c.total / c.window) * 100);
    const color = pct >= 85 ? t.blocked : pct >= 65 ? t.done : t.accent;
    const free = Math.max(0, c.window - c.total);
    return root
      .child(this.header(t, "simple", c.model))
      .when(!!c.title, (el) => el.child(div().text_size(11.5).text_color(t.muted).truncate().child(c.title)))
      .child(v_flex().gap(6)
        .child(h_flex().items_end().gap(6)
          .child(div().text_size(20).font_semibold().text_color(color).child(`${Math.round(pct)}%`))
          .child(div().pb(3).text_size(11.5).text_color(t.dim).child(`${fmt(c.total)} of ${fmt(c.window)} tokens`)))
        .child(div().w_full().h(6).rounded(3).bg(t.raised)
          .child(div().h_full().rounded(3).bg(color).w(`${Math.max(pct, 1)}%`).transition("width", 400))))
      .child(div().h(1).bg(t.border))
      .when(!!c.compacted, (el) => el
        .child(this.row(t, "Compacted", `${fmt(c.compacted.pre)} → ${fmt(c.total)}`))
        .child(div().text_size(11).text_color(t.dim).child("Exact numbers return after the next reply.")))
      .when(!c.compacted, (el) => el
        // Usage of the last API call (a prompt can take many: one per tool use).
        // Claude Code caches up to the end of each request, so what the call
        // added (prompt, tool results) is nearly all cache write; input_tokens
        // is the few tokens past the cache point.
        .child(this.row(t, "Already in context", fmt(c.cacheRead)))
        .child(this.row(t, "Added last step", fmt(c.cacheWrite + c.input)))
        .child(this.row(t, "Last step's reply", fmt(c.output))))
      .child(this.row(t, "Free", fmt(free)))
      .child(div().flex_1())
      .child(this.compactButton(t, p));
  }

  renderDetailed(cx, t, p, c, root) {
    // Refresh after each step (the header updates c.at), one run at a time.
    if (c.sessionId && !this.loading && this.detailAt !== c.at) this.fetchDetail(cx, c);
    const d = this.detail;
    root = root.child(this.header(t, "detailed", d?.model ?? c.model));
    if (!d) {
      return root
        .child(div().text_size(12).text_color(this.err ? t.blocked : t.dim)
          .when(!this.err, (el) => el.frames(["Reading /context", "Reading /context.", "Reading /context..", "Reading /context..."], 300))
          .when(!!this.err, (el) => el.child(this.err)))
        .child(div().flex_1())
        .child(this.compactButton(t, p));
    }

    const window = d.window ?? c.window;
    const used = d.used ?? c.total;
    const pct = window ? Math.min(100, used / window * 100) : 0;
    const inWindow = d.categories.filter((k) => !outside(k.name));
    const extra = d.categories.filter((k) => outside(k.name));
    // Bar: used categories in order, then the autocompact buffer; free space is the track.
    const segs = inWindow.filter((k) => !/^free/i.test(k.name) && k.tokens > 0);

    const catRow = (k, inside) => h_flex().items_center().gap(8).h(22).text_size(12)
      .child(div().size(10).rounded(2).flex_none().bg(categoryColor(t, k.name))
        .when(/^free/i.test(k.name), (el) => el.border_1().border_color(t.border)))
      .child(div().flex_1().truncate().text_color(t.foreground).child(k.name))
      .child(div().text_color(t.muted).child(fmt(k.tokens)))
      .child(div().w(46).flex_none().text_right().text_color(t.dim).child(inside ? pctText(k.tokens, window) : "—"));

    const section = (s) => {
      const open = !!this.open[s.title];
      return v_flex()
        .child(h_flex().id(`cc-sec-${s.title}`).items_center().gap(6).h(24).text_size(12).cursor_pointer()
          .rounded(4).hover((el) => el.bg(t.hover))
          .on_click((_e, cx) => { this.open[s.title] = !open; cx.notify(); })
          .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none().text_color(t.dim))
          .child(div().flex_1().text_color(t.muted).child(s.title))
          .child(div().text_color(t.dim).child(String(s.rows.length))))
        .when(open, (el) => el.children(s.rows.map((r, i) =>
          h_flex().id(`cc-${s.title}-${i}`).items_center().gap(8).pl(17).h(20).text_size(11.5)
            .when(!!r.sub, (row) => row.tooltip(r.sub))
            .child(div().flex_1().truncate().text_color(t.foreground).child(r.label))
            .child(div().flex_none().text_color(t.dim).child(r.tokens != null && !/[~<]/.test(r.raw) ? fmt(r.tokens) : r.raw)))));
    };

    return root
      .child(v_flex().gap(6).flex_none()
        .child(h_flex().items_end().justify_between()
          .child(div().text_size(15).font_semibold().child(`${Math.round(pct)}% used`))
          .child(div().text_size(11.5).text_color(t.dim).child(`${fmt(used)} / ${fmt(window)}`)))
        .child(h_flex().w_full().h(6).rounded(3).overflow_hidden().bg(t.raised)
          .children(segs.map((k) => div().h_full().flex_none().bg(categoryColor(t, k.name))
            .w(`${Math.max(k.tokens / window * 100, 0.6)}%`)))))
      .child(v_flex().id("cc-detail").flex_1().overflow_y_scrollbar()
        .children(inWindow.map((k) => catRow(k, true)))
        .when(extra.length > 0, (el) => el.child(div().h(6)).children(extra.map((k) => catRow(k, false))))
        .when(d.sections.length > 0, (el) => el.child(div().h(1).my(6).bg(t.border)).children(d.sections.map(section))))
      .child(h_flex().items_center().justify_between().flex_none()
        .child(div().text_size(10.5).text_color(t.dim).child(this.loading ? "Refreshing…" : this.err ? `Stale: ${this.err}` : "Estimated by Claude Code"))
        .child(this.compactButton(t, p)));
  }
}
