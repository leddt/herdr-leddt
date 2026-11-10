// The Review button's popup: pick the branch to review against (the nearest
// ancestor branch first, down to main), then start the session: a fresh Claude
// reviewer running /code-review, the Findings pane beside the agent, and the
// reviewer's pane under it.
// Props: { mode: "pick", origin: <terminal>, pane: <pane>, cwd, overlay }.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, theme, run, panes, exec, notify, shared, setShared } from "herdr";
import * as fs from "fs/promises";
import { baseCandidates, resolveBase, sessionDir, saveState, reviewTask } from "./session.js";

const REMEMBER = "leddt-review.bases";
// session id → its Findings pane (read by leddt-pane's Review button).
const PANES = "leddt-review.panes";

export class Picker {
  init(view, cx) {
    this.view = view;
    this.rows = null;
    this.error = null;
    this.selected = 0;
    this.custom = "";
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Or type a ref: a branch, tag or SHA" });
    this.input.on("change", (_e, cx) => { this.custom = this.input.value().trim(); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.start(cx, null));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    cx.timer.after(50, () => this.handle.focus());
    cx.spawn(async (cx) => {
      try {
        const info = await baseCandidates(props().cwd);
        this.info = info;
        this.rows = info.candidates;
        const remembered = (shared(REMEMBER) ?? {})[`${info.repo}@${info.branch}`];
        const i = this.rows.findIndex((r) => r.name === remembered);
        this.selected = i >= 0 ? i : 0;
      } catch (e) { this.error = String(e?.message ?? e); this.rows = []; }
      cx.notify();
    });
  }

  key(e, cx) {
    if (this.typing && e.key !== "escape") return;
    const n = this.rows?.length ?? 0;
    if (e.key === "escape") closeOverlay(props().overlay);
    else if (e.key === "down" && n) this.selected = (this.selected + 1) % n;
    else if (e.key === "up" && n) this.selected = (this.selected + n - 1) % n;
    else if (e.key === "enter" && n) this.start(cx, this.rows[this.selected]);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  start(cx, row) {
    if (this.starting) return;
    if (!row && !this.custom) return;
    this.starting = true;
    this.error = null;
    cx.notify();
    const p = props();
    cx.spawn(async (cx) => {
      try {
        const base = row ?? await resolveBase(p.cwd, this.custom);
        if (this.info) setShared(REMEMBER, { ...(shared(REMEMBER) ?? {}), [`${this.info.repo}@${this.info.branch}`]: base.name });
        await startSession(cx, p, this.info, base);
        closeOverlay(p.overlay);
      } catch (e) {
        this.error = String(e?.message ?? e);
        this.starting = false;
        cx.notify();
      }
    });
  }

  render() {
    const t = theme();
    const rows = this.rows;
    return v_flex().id("lr-pick").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().min_h(0).bg(t.popover).text_color(t.foreground).text_size(12.5)
      .child(v_flex().px(14).pt(12).pb(8).gap(2)
        .child(h_flex().items_center().gap(6)
          .child(svg("mods/leddt-review/git-compare.svg").size(14).text_color(t.dim))
          .child(div().flex_1().font_semibold().text_size(13.5).child("Review against…"))
          .child(div().text_size(11).text_color(t.dim).child("Esc")))
        .child(div().text_size(11.5).text_color(t.dim).truncate()
          .child(this.info ? `${this.info.branch ?? "detached HEAD"} · nearest ancestor branches first` : "Finding ancestor branches…")))
      .child(v_flex().id("lr-pick-list").flex_1().min_h(0).overflow_y_scroll().px(6).gap(1)
        .when(rows === null, (el) => el.child(h_flex().p(10).gap(8).items_center().text_color(t.dim)
          .child(svg("mods/leddt-review/spinner.svg").size(12).spin(900)).child("Reading branches…")))
        .when(rows !== null && rows.length === 0 && !this.error, (el) => el.child(div().p(10).text_color(t.dim).child("No ancestor branches found. Type a ref below.")))
        .children((rows ?? []).map((r, i) => h_flex().id(`lr-pick-${i}`).h(30).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer()
          .when(i === this.selected, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.selected = i; this.start(cx, r); })
          .child(div().flex_1().min_w(0).truncate().child(r.name))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(`${r.ahead} commit${r.ahead === 1 ? "" : "s"}`))
          .child(div().flex_none().w(62).text_size(10.5).text_color(t.dim).font_family("monospace").child(r.mergeBase.slice(0, 8))))))
      .when(Boolean(this.error), (el) => el.child(div().px(14).py(6).text_size(11.5).text_color(t.ansi1).child(this.error)))
      .child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("lr-pick-input").flex_1().min_w(0).h(30).px(9).flex().items_center().rounded(8).border_1()
          .border_color(this.typing ? t.accent : t.input).bg(t.background).cursor_text()
          .child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(h_flex().id("lr-pick-go").h(30).px(12).items_center().rounded(8).text_size(12).font_medium()
          .bg(this.starting ? t.raised : t.solid).text_color(this.starting ? t.dim : t.solid_foreground).cursor_pointer()
          .on_click((_e, cx) => this.start(cx, this.custom ? null : rows?.[this.selected]))
          .child(this.starting ? "Starting…" : "Review")));
  }
}

async function startSession(cx, p, info, base) {
  const id = Date.now().toString(36);
  const dir = sessionDir(id);
  await fs.mkdir(dir, { recursive: true });
  const s = {
    id, created: Date.now(), cwd: p.cwd, repo: info?.repo ?? p.cwd, branch: info?.branch ?? null,
    base: { name: base.name, sha: base.mergeBase, ahead: base.ahead },
    origin: p.origin, reviewer: null, round: 1, seq: 0, findings: [], requests: [], notice: null,
  };
  // A fresh Claude in the same folder, a sub-agent of the original (so it
  // belongs to its tab) that doesn't type notes into it, and outlives it.
  // It may write its findings into the session folder without asking.
  const r = await exec("hc", ["run", "--bg", "--json", "--name", `review-${id}`, "--cwd", p.cwd,
    "--parent", p.origin, "--no-notify", "--outlive-parent", "--label", `leddt-review=${id}`, "--",
    "claude", reviewTask(s), "--add-dir", dir, "--allowedTools", `Edit(/${dir}/**)`]);
  if (r.code !== 0) throw new Error(`Couldn't start the reviewer: ${(r.stderr || r.stdout).trim()}`);
  s.reviewer = JSON.parse(r.stdout).address;
  s.requests.push({ n: 0, kind: "review", agent: "reviewer", round: 1, launch: true, sent: true, status: "pending" });
  await saveState(s);

  // The Findings pane right of the agent, the reviewer under it.
  const before = new Set(panes().map((x) => x.pane));
  run("pane.split", { direction: "right", pane: p.pane, mod: "leddt-review", props: { session: id } });
  let mine = null;
  for (let i = 0; i < 60 && !mine; i++) {
    mine = panes().find((x) => x.mod === "leddt-review" && !before.has(x.pane));
    if (!mine) await cx.sleep(50);
  }
  if (mine) {
    // Pane mods aren't told their pane: remember it, so Review can find it again.
    setShared(PANES, { ...(shared(PANES) ?? {}), [id]: mine.pane });
    run("pane.focus", { pane: mine.pane });
  }
  run("terminal.keep", { terminal: s.reviewer, place: "down" });
  if (!mine) notify({ title: "Review started", body: `The Findings pane didn't appear; the reviewer is ${s.reviewer}.`, level: "warning" });
}
