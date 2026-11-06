// Popover with a Claude session's context usage, opened from the context chip
// in leddt-pane's header. Props: { terminal, overlay }. Follows the header's
// shared "leddt-context:<terminal>" value live.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, shared, theme, closeOverlay, hc, notify } from "herdr";

function fmt(n) {
  if (n == null) return "—";
  return n.toLocaleString("en-US");
}
function short(n) {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${+(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}
export default class ClaudeContext extends View {
  row(t, label, value) {
    return h_flex().justify_between().text_size(12)
      .child(div().text_color(t.muted).child(label))
      .child(div().text_color(t.foreground).child(value));
  }

  render() {
    const t = theme();
    const p = props() ?? {};
    const c = shared(`leddt-context:${p.terminal}`);
    const root = v_flex().id("leddt-context").size_full().p(14).gap(10).bg(t.popover).text_color(t.foreground);
    if (!c) return root.child(div().text_size(12).text_color(t.dim).child("No context data for this session yet."));
    const pct = Math.min(100, (c.total / c.window) * 100);
    const color = pct >= 85 ? t.blocked : pct >= 65 ? t.done : t.accent;
    const free = Math.max(0, c.window - c.total);
    return root
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(13.5).font_semibold().child("Context"))
        .child(div().text_size(11).text_color(t.dim).child(c.model ?? "")))
      .when(!!c.title, (el) => el.child(div().text_size(11.5).text_color(t.muted).truncate().child(c.title)))
      .child(v_flex().gap(6)
        .child(h_flex().items_end().gap(6)
          .child(div().text_size(20).font_semibold().text_color(color).child(`${Math.round(pct)}%`))
          .child(div().pb(3).text_size(11.5).text_color(t.dim).child(`${short(c.total)} of ${short(c.window)} tokens`)))
        .child(div().w_full().h(6).rounded(3).bg(t.raised)
          .child(div().h_full().rounded(3).bg(color).w(`${Math.max(pct, 1)}%`).transition("width", 400))))
      .child(div().h(1).bg(t.border))
      .when(!!c.compacted, (el) => el
        .child(this.row(t, "Compacted", `${fmt(c.compacted.pre)} → ${fmt(c.total)}`))
        .child(div().text_size(11).text_color(t.dim).child("Exact numbers return after the next reply.")))
      .when(!c.compacted, (el) => el
        .child(this.row(t, "Cached (read)", fmt(c.cacheRead)))
        .child(this.row(t, "Cache write", fmt(c.cacheWrite)))
        .child(this.row(t, "New input", fmt(c.input)))
        .child(this.row(t, "Last reply", fmt(c.output))))
      .child(this.row(t, "Free", fmt(free)))
      .child(div().flex_1())
      .child(h_flex().justify_end()
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
          .child("Compact now")));
  }
}
