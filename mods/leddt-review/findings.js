// The Findings pane: lists a review session's findings and drives the
// workflow. Each finding moves New → Triaging → Triaged → Fixing → Fixed →
// Verifying → Verified (done, grayed out).
//
// Every step is a "request": a message typed into one of the two agents with
// `hc send`, asking it to write a JSON file into the session folder. The pane
// watches that folder and applies a file as soon as it's there; when the
// agent's turn ends without one, the request shows as failed (Retry/Dismiss).
// Requests live in state.json, so a reload or restart picks them up again.
// Props: { session }.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, theme, run, exec, terminals, panes, focused, notify, watchFolder, nextCommand } from "herdr";
import {
  BUSY_BACK, loadState, saveState, readJson, sessionDir, statePath,
  reportTask, triageTask, fixTask, verifyTask, loopTask,
} from "./session.js";

const WHO = { reviewer: "Reviewer", origin: "Agent" };

async function hcJson(args, timeout) {
  const r = await exec("hc", [...args, "--json"], { timeout: timeout ?? 30000 });
  let data = null;
  try { data = JSON.parse(r.stdout); } catch {}
  return { code: r.code, data, text: (r.stderr || r.stdout).trim() };
}

// `hc get` reports status as {app, state, msg}, `hc wait` as a plain word;
// null when the terminal is gone.
function statusOf(g) {
  if (g.code !== 0 || g.data?.state === "finished") return null;
  return typeof g.data?.status === "object" ? g.data.status?.state : g.data?.status;
}

export class Findings {
  init(view, cx) {
    this.view = view;
    this.id = props()?.session;
    this.s = null;
    // Requests being driven: n → agent. One at a time per agent.
    this.running = new Map();
    this.open = new Set();
    this.saving = Promise.resolve();
    cx.spawn(async (cx) => {
      this.s = await loadState(this.id);
      if (!this.s) { this.missing = true; cx.notify(); return; }
      await this.checkFiles(cx);
      this.pump(cx);
      cx.notify();
      this.watch(cx);
    });
    // Key commands (keys.json "…": "leddt-review:fix") reach every shown
    // Findings pane; only the one for the focused tab's session acts.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (!this.s || !this.inFocusedTab()) continue;
        if (c === "fix") this.fix(cx);
        else if (c === "verify") this.verify(cx);
        else if (c === "loop") this.loop(cx);
        else if (c === "triage") this.triageNew(cx);
        cx.notify();
      }
    });
  }

  watch(cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        try { await watchFolder(sessionDir(this.id)); }
        catch { await cx.sleep(3000); }
        // A throw here must not end the loop: the next change tries again.
        try { await this.checkFiles(cx); } catch {}
        cx.notify();
      }
    });
  }

  save() {
    const snapshot = JSON.parse(JSON.stringify(this.s));
    this.saving = this.saving.then(() => saveState(snapshot)).then(
      () => { this.saveFailed = false; },
      (e) => {
        // Once per run of failures; the chain carries on with the next save.
        if (this.saveFailed) return;
        this.saveFailed = true;
        notify({ title: "Review: couldn't save the session", body: `${statePath(this.id)}: ${e?.message ?? e}`, level: "error" });
      });
    return this.saving;
  }

  alive(addr) { return Boolean(addr) && terminals().some((x) => x.address === addr && x.state === "live"); }

  // This session's agent or reviewer is in the focused tab.
  inFocusedTab() {
    const tab = focused()?.tab;
    return Boolean(tab) && panes().some((p) => p.tab === tab && p.terminal && (p.terminal === this.s.origin || p.terminal === this.s.reviewer));
  }

  find(id) { return this.s.findings.find((f) => f.id === id); }
  pending(agent) { return this.s.requests.find((r) => r.status === "pending" && (!agent || r.agent === agent)); }
  fileOf(req) { return req.file ? `${sessionDir(this.id)}/${req.file}` : null; }

  // --- requests -----------------------------------------------------------------

  request(cx, kind, agent, ids, build) {
    const n = ++this.s.seq;
    // A review round writes no file: its report request (sent when it ends) does.
    const file = kind === "review" ? null : kind === "report" ? `findings-r${this.s.round}.json` : `${kind}-${n}.json`;
    const req = { n, kind, agent, ids, file, round: this.s.round, sent: false, status: "pending" };
    req.text = build(`${sessionDir(this.id)}/${file}`);
    this.s.requests.push(req);
    const busy = { triage: "Triaging", fix: "Fixing", verify: "Verifying" }[kind];
    if (busy) for (const id of ids) { const f = this.find(id); if (f) f.state = busy; }
    this.s.notice = null;
    this.save();
    this.pump(cx);
    cx.notify();
  }

  // Start the oldest pending request of each agent that isn't busy with one:
  // a second message typed into an agent mid-turn would mix the two up.
  pump(cx) {
    const busy = new Set(this.running.values());
    for (const req of this.s.requests) {
      if (req.status !== "pending" || busy.has(req.agent)) continue;
      busy.add(req.agent);
      this.drive(req, cx);
    }
  }

  // Send the request (once), then follow the agent until its turn ends.
  drive(req, cx) {
    this.running.set(req.n, req.agent);
    cx.spawn(async (cx) => {
      try {
        const addr = this.s[req.agent];
        if (!req.sent) {
          // Marked sent first: a reload while `send --wait` runs must not send it twice.
          req.sent = true;
          await this.save();
          const r = await hcJson(["send", "--wait", "--timeout", "540", addr, req.text], 600000);
          if (r.code !== 0 && r.data?.reason !== "timeout") { req.sent = false; return this.fail(req, `Couldn't send to ${WHO[req.agent]} (${addr}): ${r.text}`, cx); }
        } else if (req.launch) {
          // A fresh Claude may sit idle for a moment before it picks up its
          // prompt, and idle ends `hc wait`: first see it start (up to a minute).
          for (let i = 0; i < 60; i++) {
            const st = statusOf(await hcJson(["get", addr]));
            if (st === "working" || st === "blocked" || st === null) break;
            await cx.sleep(1000);
          }
          await hcJson(["wait", addr, "--timeout", "540"], 600000);
        }
        // Until it's done with the turn: keep waiting while it works, and while
        // it's blocked (a permission dialog: the person answers it).
        for (;;) {
          if (req.status !== "pending") return;
          const g = await hcJson(["get", addr]);
          if (g.code !== 0 || g.data?.state === "finished") return this.fail(req, `${WHO[req.agent]} (${addr}) is gone.`, cx);
          const st = statusOf(g);
          req.blocked = st === "blocked";
          cx.notify();
          if (st === "working") await hcJson(["wait", addr, "--timeout", "540"], 600000);
          else if (st === "blocked") await cx.sleep(2000);
          else break;
        }
        await this.checkFiles(cx, true);
        if (req.status !== "pending") return;
        if (req.kind === "review") {
          this.done(req);
          this.request(cx, "report", "reviewer", [], (path) => reportTask(this.s, req.round, path));
        } else {
          this.fail(req, `${WHO[req.agent]} finished without writing ${req.file}.`, cx);
        }
      } catch (e) {
        this.fail(req, String(e?.message ?? e), cx);
      } finally {
        this.running.delete(req.n);
        // The agent is free: the next request queued for it can go.
        this.pump(cx);
        cx.notify();
      }
    });
  }

  done(req) {
    // Not "pending" any more: a checkFiles or drive still holding it leaves it alone.
    req.status = "done";
    this.s.requests = this.s.requests.filter((r) => r !== req);
    this.save();
  }

  fail(req, message, cx) {
    req.status = "error";
    req.error = message;
    req.blocked = false;
    this.save();
    cx.notify();
  }

  retry(req, cx) {
    req.status = "pending";
    req.error = null;
    req.sent = req.kind === "review" ? req.sent : false;
    this.save();
    this.pump(cx);
    cx.notify();
  }

  dismiss(req, cx) {
    for (const id of req.ids ?? []) {
      const f = this.find(id);
      if (f && BUSY_BACK[f.state]) f.state = BUSY_BACK[f.state];
    }
    this.done(req);
    cx.notify();
  }

  // Apply any result file that's there. `final`: the agent's turn ended, so a
  // file that doesn't parse is an error (before that it may be half written).
  async checkFiles(cx, final) {
    if (!this.s) return;
    for (const req of [...this.s.requests]) {
      if (req.status !== "pending" || !req.file) continue;
      const r = await readJson(this.fileOf(req));
      if (r.missing || req.status !== "pending") continue;
      if (r.error) { if (final) this.fail(req, r.error, cx); continue; }
      try { this.apply(req, r.data, cx); }
      catch (e) { if (final) this.fail(req, `${req.file}: ${e?.message ?? e}`, cx); continue; }
      this.done(req);
    }
  }

  apply(req, data, cx) {
    const list = (key) => {
      const v = data?.[key];
      if (!Array.isArray(v)) throw new Error(`expected {"${key}": [...]}`);
      // Checked up front: a throw halfway would leave half the file applied,
      // and the next check would apply that half again.
      if (v.some((x) => !x || typeof x !== "object" || Array.isArray(x))) throw new Error(`every "${key}" entry must be an object`);
      return v;
    };
    if (req.kind === "report") {
      const fresh = [], added = [];
      for (const raw of list("findings")) {
        let id = String(raw.id ?? `R${req.round}-${fresh.length + 1}`);
        while (this.find(id) || fresh.includes(id)) id += "'";
        added.push({
          id, round: req.round, title: raw.title ?? "(untitled)", file: raw.file ?? null, line: raw.line ?? null,
          severity: raw.severity ?? null, description: raw.description ?? "", failure: raw.failure ?? null,
          repeats: raw.repeats ?? null, state: "New", checked: true,
        });
        fresh.push(id);
      }
      this.s.findings.push(...added);
      if (!fresh.length) this.s.notice = `Round ${req.round}: the reviewer found nothing.`;
      else this.queueTriage(cx, fresh);
    } else if (req.kind === "triage") {
      const seen = new Set();
      for (const t of list("triage")) {
        const f = this.find(String(t.id));
        if (!f || !req.ids.includes(f.id)) continue;
        f.triage = { status: t.status ?? null, impact: t.impact ?? null, recommendation: t.recommendation ?? "", reason: t.reason ?? "" };
        f.state = "Triaged";
        seen.add(f.id);
      }
      this.leftover(req, seen, "New", "Not triaged");
    } else if (req.kind === "fix") {
      const seen = new Set();
      for (const x of list("fixed")) {
        const f = this.find(String(x.id));
        if (!f || !req.ids.includes(f.id)) continue;
        const ok = x.fixed !== false;
        f.fix = { ok, note: x.note ?? "" };
        f.state = ok ? "Fixed" : "Triaged";
        seen.add(f.id);
      }
      this.leftover(req, seen, "Triaged", "Not reported as fixed");
    } else if (req.kind === "verify") {
      const seen = new Set();
      for (const x of list("verify")) {
        const f = this.find(String(x.id));
        if (!f || !req.ids.includes(f.id)) continue;
        const ok = x.verified === true;
        f.verify = { ok, note: x.note ?? "" };
        // Not fixed after all: back to Triaged, to fix again.
        f.state = ok ? "Verified" : "Triaged";
        if (ok) f.checked = false;
        seen.add(f.id);
      }
      this.leftover(req, seen, "Fixed", "Not verified");
    }
    this.save();
  }

  leftover(req, seen, back, note) {
    for (const id of req.ids) {
      const f = this.find(id);
      if (f && !seen.has(id) && BUSY_BACK[f.state]) { f.state = back; f.note = note; }
    }
  }

  // --- actions ------------------------------------------------------------------

  queueTriage(cx, ids) {
    const findings = ids.map((id) => this.find(id)).filter(Boolean);
    this.request(cx, "triage", "origin", ids, (path) => triageTask(this.s, findings, path));
  }

  picked(state) { return this.s.findings.filter((f) => f.checked && f.state === state); }

  fix(cx) {
    const fs = this.picked("Triaged");
    if (!fs.length || this.pending("origin")) return;
    // A fresh attempt: drop the last fix/verify outcome (a failed verify brings it back here).
    for (const f of fs) { f.note = null; f.fix = null; f.verify = null; }
    this.request(cx, "fix", "origin", fs.map((f) => f.id), (path) => fixTask(this.s, fs, path));
  }

  verify(cx) {
    const fs = this.picked("Fixed");
    if (!fs.length || this.pending("reviewer") || !this.alive(this.s.reviewer)) return;
    this.request(cx, "verify", "reviewer", fs.map((f) => f.id), (path) => verifyTask(this.s, fs, path));
  }

  triageNew(cx) {
    const fs = this.picked("New");
    if (!fs.length || this.pending("origin")) return;
    this.queueTriage(cx, fs.map((f) => f.id));
  }

  loop(cx) {
    if (this.pending("reviewer") || !this.alive(this.s.reviewer)) return;
    this.s.round += 1;
    this.request(cx, "review", "reviewer", [], () => loopTask(this.s));
  }

  // --- view ---------------------------------------------------------------------

  activity(req) {
    const n = req.ids?.length ?? 0, s = n === 1 ? "" : "s";
    if (req.blocked) return `${WHO[req.agent]} needs you (${this.s[req.agent]})`;
    if (!this.running.has(req.n)) return `Next for ${WHO[req.agent]}, when it's done: ` + {
      review: `review round ${req.round}`, report: "write up its findings", triage: `triage ${n} finding${s}`,
      fix: `fix ${n} finding${s}`, verify: `verify ${n} fix${n === 1 ? "" : "es"}`,
    }[req.kind];
    return {
      review: `Reviewer is reviewing (round ${req.round})…`,
      report: "Reviewer is writing up its findings…",
      triage: `Agent is triaging ${n} finding${s}…`,
      fix: `Agent is fixing ${n} finding${s}…`,
      verify: `Reviewer is verifying ${n} fix${n === 1 ? "" : "es"}…`,
    }[req.kind];
  }

  render(cx) {
    const t = theme();
    if (this.missing) return div().size_full().p(16).bg(t.background).text_color(t.dim).child("This review session is gone.");
    if (!this.s) return div().size_full().bg(t.background);
    const s = this.s;
    const alive = new Set(terminals().filter((x) => x.state === "live").map((x) => x.address));
    const reviewerBusy = Boolean(this.pending("reviewer")), originBusy = Boolean(this.pending("origin"));
    const toFix = this.picked("Triaged").length, toVerify = this.picked("Fixed").length, toTriage = this.picked("New").length;
    const total = s.findings.length, doneCount = s.findings.filter((f) => f.state === "Verified").length;
    const open = s.findings.filter((f) => f.state !== "Verified");
    const allChecked = open.length > 0 && open.every((f) => f.checked);

    const button = (id, label, enabled, primary, action, tip) => h_flex().id(id).h(26).px(10).items_center().rounded(7)
      .text_size(12).font_medium().flex_none()
      .bg(enabled ? (primary ? t.solid : t.raised) : t.surface)
      .text_color(enabled ? (primary ? t.solid_foreground : t.foreground) : t.dim)
      .border_1().border_color(!enabled ? t.surface : primary ? t.solid : t.input)
      .when(enabled, (el) => el.cursor_pointer().hover((st) => st.opacity(0.88)).on_click((_e, cx) => { action(cx); cx.notify(); }))
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .child(label);
    const link = (id, label, addr) => h_flex().id(id).px(6).h(20).items_center().rounded(5).text_size(11)
      .text_color(alive.has(addr) ? t.muted : t.dim).cursor_pointer().hover((st) => st.bg(t.hover).text_color(t.foreground))
      .tooltip(alive.has(addr) ? `Go to ${addr}` : `${addr} has ended`)
      // Its pane when it has one, else (a sub-agent) peek at it, as the agents list does.
      .on_click(() => {
        if (!alive.has(addr)) return;
        if (panes().some((x) => x.terminal === addr)) run("pane.focus", { terminal: addr });
        else run("terminal.peek", { terminal: addr });
      })
      .child(`${label} ${addr}`);

    const work = s.requests.filter((r) => r.status === "pending");
    const errors = s.requests.filter((r) => r.status === "error");

    return v_flex().id(`lr-${this.id}`).size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(12.5)
      // Header: what is reviewed, against what.
      .child(v_flex().flex_none().px(12).pt(10).pb(8).gap(4).border_b(1).border_color(t.border)
        .child(h_flex().gap(8).items_center()
          .child(svg("mods/leddt-review/git-compare.svg").size(14).text_color(t.dim))
          .child(div().font_semibold().text_size(13).child("Findings"))
          .child(div().text_size(11).text_color(t.dim).child(total ? `${doneCount}/${total} done · round ${s.round}` : `round ${s.round}`))
          .child(div().flex_1())
          .child(link("lr-go-origin", "Agent", s.origin))
          .child(link("lr-go-reviewer", "Reviewer", s.reviewer)))
        .child(div().text_size(11.5).text_color(t.dim).truncate()
          .child(`${s.branch ?? "HEAD"} since ${s.base.name} · ${s.base.sha.slice(0, 8)} · ${s.base.ahead} commit${s.base.ahead === 1 ? "" : "s"}`)))
      // What's happening now, and what went wrong.
      .children(work.map((r) => h_flex().flex_none().px(12).py(6).gap(8).items_center().border_b(1).border_color(t.border)
        .bg(r.blocked ? t.blocked + "1a" : t.surface).text_size(12).text_color(r.blocked ? t.blocked : t.muted)
        .child(r.blocked ? div().size(7).rounded(4).bg(t.blocked)
          : this.running.has(r.n) ? svg("mods/leddt-review/spinner.svg").size(12).text_color(t.working).spin(900)
          : div().size(7).rounded(4).bg(t.dim))
        .child(div().flex_1().truncate().child(this.activity(r)))))
      .children(errors.map((r) => h_flex().flex_none().px(12).py(6).gap(8).items_center().border_b(1).border_color(t.border)
        .bg(t.ansi1 + "14").text_size(12)
        .child(div().flex_1().min_w(0).text_color(t.ansi1).child(r.error ?? "Failed"))
        .child(button(`lr-retry-${r.n}`, "Retry", true, false, (cx) => this.retry(r, cx)))
        .child(button(`lr-dismiss-${r.n}`, "Dismiss", true, false, (cx) => this.dismiss(r, cx)))))
      .when(Boolean(s.notice), (el) => el.child(div().flex_none().px(12).py(6).text_size(12).text_color(t.muted).border_b(1).border_color(t.border).child(s.notice)))
      // The findings.
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("lr-list").absolute().inset_0().overflow_y_scroll().p(8).gap(6)
          .when(!total && !work.length && !s.notice, (el) => el.child(div().p(8).text_color(t.dim).child("No findings yet.")))
          .children(s.findings.map((f) => this.card(f, t)))))
      // Actions.
      .child(h_flex().flex_none().px(10).py(8).gap(6).items_center().border_t(1).border_color(t.border)
        .child(h_flex().id("lr-all").gap(6).items_center().cursor_pointer().text_size(11.5).text_color(t.muted)
          .on_click((_e, cx) => { for (const f of open) f.checked = !allChecked; this.save(); cx.notify(); })
          .child(this.box(allChecked, t)).child("All"))
        .child(div().flex_1())
        .when(toTriage > 0, (el) => el.child(button("lr-triage", `Triage (${toTriage})`, !originBusy, false, (cx) => this.triageNew(cx), "Ask the agent to triage the checked new findings")))
        .child(button("lr-fix", toFix ? `Fix (${toFix})` : "Fix", toFix > 0 && !originBusy, true, (cx) => this.fix(cx), "Ask the agent to fix the checked triaged findings"))
        .child(button("lr-verify", toVerify ? `Verify (${toVerify})` : "Verify", toVerify > 0 && !reviewerBusy && alive.has(s.reviewer), false, (cx) => this.verify(cx), "Ask the reviewer to check the checked fixed findings"))
        .child(button("lr-loop", "Loop", !reviewerBusy && alive.has(s.reviewer), false, (cx) => this.loop(cx), "Ask the same reviewer for another round")));
  }

  box(on, t, disabled) {
    return div().size(14).flex_none().rounded(4).border_1().flex().items_center().justify_center()
      .border_color(on ? t.accent : t.input).bg(on ? t.accent : t.background).when(Boolean(disabled), (el) => el.opacity(0.4))
      .when(on, (el) => el.child(svg("mods/leddt-review/check.svg").size(10).text_color(t.accent_foreground)));
  }

  badge(text, color, t, spin) {
    return h_flex().flex_none().h(18).px(6).gap(4).items_center().rounded(5).bg(color + "22").text_size(10.5).font_semibold().text_color(color)
      .when(Boolean(spin), (el) => el.child(svg("mods/leddt-review/spinner.svg").size(9).spin(900)))
      .child(text);
  }

  card(f, t) {
    const done = f.state === "Verified";
    const busy = Boolean(BUSY_BACK[f.state]);
    const stateColor = { New: t.muted, Triaging: t.working, Triaged: t.accent, Fixing: t.working, Fixed: t.done, Verifying: t.working, Verified: t.dim }[f.state] ?? t.muted;
    const impact = f.triage?.impact, status = f.triage?.status;
    const impactColor = { Critical: t.ansi1, Major: t.blocked, Minor: t.accent, Trivial: t.dim }[impact] ?? t.dim;
    const statusColor = { Valid: t.ansi2, Partial: t.blocked, Invalid: t.dim }[status] ?? t.dim;
    const expanded = this.open.has(f.id);
    const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : null;
    const section = (label, text, color) => text ? v_flex().gap(2)
      .child(div().text_size(10.5).font_semibold().text_color(t.dim).child(label))
      .child(div().text_size(12).text_color(color ?? t.foreground).whitespace_normal().child(String(text))) : null;

    return v_flex().id(`lr-f-${f.id}`).flex_none().p(10).gap(6).rounded(8).border_1().border_color(t.border).bg(t.surface)
      .when(done, (el) => el.opacity(0.5))
      .child(h_flex().gap(8).items_start()
        .child(div().id(`lr-cb-${f.id}`).pt(2).cursor_pointer()
          .on_click((_e, cx) => { if (done) return; cx.stop_propagation(); f.checked = !f.checked; this.save(); cx.notify(); })
          .child(this.box(f.checked && !done, t, done)))
        .child(v_flex().flex_1().min_w(0).gap(4).id(`lr-head-${f.id}`).cursor_pointer()
          .on_click((_e, cx) => { expanded ? this.open.delete(f.id) : this.open.add(f.id); cx.notify(); })
          .child(h_flex().gap(6).items_start()
            .child(div().flex_none().mt(1).px(5).h(16).flex().items_center().rounded(4).border_1().border_color(t.input)
              .text_size(10.5).font_semibold().text_color(t.muted).child(f.id))
            .child(div().flex_1().min_w(0).text_size(12.5).font_medium().whitespace_normal().when(done, (el) => el.line_through()).child(f.title)))
          .child(h_flex().gap(5).items_center().flex_wrap()
            .child(this.badge(f.state, stateColor, t, busy))
            .when(Boolean(status), (el) => el.child(this.badge(status, statusColor, t)))
            .when(Boolean(impact), (el) => el.child(this.badge(impact, impactColor, t)))
            .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(where))))
          .when(Boolean(f.triage?.recommendation), (el) => el.child(div().text_size(12).text_color(t.foreground).whitespace_normal()
            .child(`→ ${f.triage.recommendation}`)))
          .when(Boolean(f.note) || f.verify?.ok === false || f.fix?.ok === false, (el) => el.child(div().text_size(11.5).text_color(t.blocked).whitespace_normal()
            .child(f.verify?.ok === false ? `Verify: not fixed. ${f.verify.note}` : f.fix?.ok === false ? `Not fixed: ${f.fix.note}` : f.note)))))
      .when(expanded, (el) => el.child(v_flex().pl(22).gap(8).pt(2)
        .children([
          section("Finding", f.description),
          section("Failure", f.failure),
          section("Triage", f.triage?.reason),
          section("Fix", f.fix?.note),
          section("Verification", f.verify?.note),
          section("Repeats", f.repeats),
        ].filter(Boolean))));
  }
}
