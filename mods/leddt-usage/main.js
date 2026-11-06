import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, home, readTextFile } from "herdr";

const URL = "https://api.anthropic.com/api/oauth/usage";

function untilText(iso) {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (!(ms > 0)) return "now";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export default class ClaudeUsage extends View {
  init(_props, cx) {
    this.data = null;
    this.error = null;
    this.refresh(cx);
    cx.timer.every(120000, (cx) => this.refresh(cx));
  }

  refresh(cx) {
    cx.spawn(async (cx) => {
      try {
        const raw = await readTextFile(`${home()}/.claude/.credentials.json`);
        const token = raw && JSON.parse(raw)?.claudeAiOauth?.accessToken;
        if (!token) throw new Error("not signed in");
        const r = await fetch(URL, {
          headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
        });
        if (r.status === 401) throw new Error("token expired: run claude");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        this.data = await r.json();
        this.error = null;
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  bar(id, label, entry) {
    const t = theme();
    const pct = Math.max(0, Math.min(100, entry?.utilization ?? 0));
    const color = pct >= 90 ? t.blocked : pct >= 70 ? t.done : t.accent;
    return v_flex().id(id).gap(3).w_full()
      .child(h_flex().justify_between().text_size(11)
        .child(div().text_color(t.muted).child(label))
        .child(div().text_color(t.dim).child(
          entry ? `${Math.round(pct)}% · ${untilText(entry.resets_at)}` : "—")))
      .child(div().w_full().h(5).rounded(3).bg(t.raised)
        .child(div().h_full().rounded(3).bg(color).w(`${pct}%`)
          .transition("width", 400)));
  }

  render() {
    const t = theme();
    return v_flex().id("root").size_full().bg(t.chrome).border_t(1).border_color(t.border)
      .px(12).py(8).gap(7).justify_center().cursor_pointer()
      .on_click((_e, cx) => this.refresh(cx))
      .child(this.bar("five", "Session (5h)", this.data?.five_hour))
      .child(this.bar("week", "Weekly", this.data?.seven_day))
      .when(!!this.error, (el) => el.child(div().text_size(10).text_color(t.blocked).truncate().child(this.error)));
  }
}
