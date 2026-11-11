import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, home, readTextFile } from "herdr";

const URL = "https://api.anthropic.com/api/oauth/usage";
const POLL_MS = 5 * 60000;
const CLICK_MS = 30000;
const MAX_BACKOFF_MS = 60 * 60000;

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

// The empty part of a meter: `dim` at 40%, so it shows on `chrome` in light and dark themes alike
// (`raised` is too close to `chrome` in some themes).
function track(t) {
  return /^#[0-9a-f]{6}$/i.test(t.dim) ? `${t.dim}66` : t.border;
}

// One line, drawn beside workspace-status at the bottom of the work column.
export default class ClaudeUsage extends View {
  init(_props, cx) {
    this.data = null;
    this.error = null;
    this.busy = false;
    this.lastAt = 0;        // when the last request was sent
    this.nextAt = 0;        // when the next scheduled poll is due
    this.blockedUntil = 0;  // after a 429: no request before this, not even on click
    this.backoff = 0;
    this.refresh(cx);
    cx.timer.every(30000, (cx) => this.refresh(cx));
  }

  // The endpoint is rate-limited and Claude Code uses it with the same token, so: one request at
  // a time, a poll every POLL_MS, clicks at most every CLICK_MS, and after a 429 nothing until
  // Retry-After (or a doubling backoff) has passed. A 429 keeps the last values on screen.
  refresh(cx, manual = false) {
    const now = Date.now();
    if (this.busy || now < this.blockedUntil) return;
    if (manual ? now - this.lastAt < CLICK_MS : now < this.nextAt) return;
    this.busy = true;
    this.lastAt = now;
    this.nextAt = now + POLL_MS;
    cx.spawn(async (cx) => {
      try {
        const raw = await readTextFile(`${home()}/.claude/.credentials.json`);
        const token = raw && JSON.parse(raw)?.claudeAiOauth?.accessToken;
        if (!token) throw new Error("not signed in");
        const r = await fetch(URL, {
          headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
        });
        if (r.status === 429) {
          const after = Number(r.headers?.get?.("retry-after")) * 1000;
          this.backoff = Math.min(this.backoff ? this.backoff * 2 : POLL_MS, MAX_BACKOFF_MS);
          this.blockedUntil = Date.now() + Math.max(after > 0 ? after : 0, this.backoff);
          this.error = this.data ? null : "rate limited, will retry";
        } else {
          if (r.status === 401) throw new Error("token expired: run claude");
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          this.data = await r.json();
          this.error = null;
          this.backoff = 0;
        }
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.busy = false;
      cx.notify();
    });
  }

  meter(id, label, entry) {
    const t = theme();
    const pct = Math.max(0, Math.min(100, entry?.utilization ?? 0));
    const color = pct >= 90 ? t.blocked : pct >= 70 ? t.done : t.accent;
    return h_flex().id(id).flex_none().gap(6).items_center().whitespace_nowrap()
      .child(div().text_color(t.muted).child(label))
      .child(div().w(44).h(4).rounded(2).bg(track(t))
        .child(div().h_full().rounded(2).bg(color).w(`${pct}%`).transition("width", 400)))
      .child(div().text_color(t.dim).child(
        entry ? `${Math.round(pct)}% · ${untilText(entry.resets_at)}` : "—"));
  }

  render() {
    const t = theme();
    return h_flex().id("root").size_full().bg(t.chrome).border_t(1).border_color(t.border)
      .px(14).gap(14).items_center().overflow_hidden().text_size(11.8).cursor_pointer()
      .on_click((_e, cx) => this.refresh(cx, true))
      .when(!!this.error, (el) => el.child(div().text_color(t.blocked).truncate().child(this.error)))
      .when(!this.error, (el) => el
        .child(this.meter("five", "5h", this.data?.five_hour))
        .child(this.meter("week", "Week", this.data?.seven_day)));
  }
}
