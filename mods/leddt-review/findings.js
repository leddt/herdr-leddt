// The Findings pane: lists a review session's findings and drives the
// workflow. Each finding moves New → Triaging → Triaged → Fixing → Fixed →
// Verifying → Verified (done, grayed out). New, Triaged and Fixed findings can
// also be Ignored, which counts as done too (and Restore puts them back).
//
// Every step is a "request": a message typed into one of the two agents with
// `hc send`, asking it to write a JSON file into the session folder. The pane
// watches that folder and applies a file as soon as it's there; when the
// agent's turn ends without one, the request shows as failed (Retry/Dismiss).
// Requests live in state.json, so a reload or restart picks them up again.
// Props: { session }.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, theme, run, exec, terminals, panes, focused, notify, shared, setShared, openOverlay, watchFolder, nextCommand } from "herdr";
import {
  BUSY_BACK, PANES, loadState, saveState, readJson, sessionDir, statePath, archiveDir,
  reportTask, triageTask, fixTask, verifyTask, loopTask,
} from "./session.js";

const WHO = { reviewer: "Reviewer", origin: "Agent" };
// Done: grayed out, out of "All", and what Archive hides.
const DONE = new Set(["Verified", "Ignored"]);
// What Ignore takes: findings no request is working on, not done yet.
const IGNORABLE = new Set(["New", "Triaged", "Fixed"]);

// Mod command names take only a-z and -: a session id's digits become -a..-j.
const cmdId = (id) => id.replace(/[0-9]/g, (d) => "-" + "abcdefghij"[Number(d)]);

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
    // Finding id → its instruction field's InputState, made on first click
    // (an InputState can't be made in render).
    this.inputs = new Map();
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
    // Findings pane; only one session acts (see keyTarget).
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        // From the Done confirmation: names its session, so no focus check.
        if (this.s && c === `archive-${cmdId(this.id)}`) { await this.archiveSession(cx); continue; }
        if (!this.s || this.closed || !this.keyTarget()) continue;
        if (c === "fix") this.fix(cx);
        else if (c === "verify") this.verify(cx);
        else if (c === "loop") this.loop(cx);
        else if (c === "ignore") this.ignore(cx);
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
    // Archived: its folder has moved, and a late save would bring it back.
    if (this.closed) return this.saving;
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

  // Whether a key command is for this session: the focused Findings pane's,
  // else the newest one with a Findings pane in the focused tab, else (pane
  // not remembered) one whose agent or reviewer is in that tab.
  keyTarget() {
    const f = focused();
    if (!f?.tab) return false;
    const map = Object.entries(shared(PANES) ?? {});
    const own = map.find(([, pane]) => pane === f.pane);
    if (own) return own[0] === this.id;
    const inTab = new Set(panes().filter((p) => p.tab === f.tab && p.mod === "leddt-review").map((p) => p.pane));
    const here = map.filter(([, pane]) => inTab.has(pane)).map(([id]) => id);
    if (here.length) return here.sort((a, b) => parseInt(b, 36) - parseInt(a, 36))[0] === this.id;
    return panes().some((p) => p.tab === f.tab && p.terminal && (p.terminal === this.s.origin || p.terminal === this.s.reviewer));
  }

  find(id) { return this.s.findings.find((f) => f.id === id); }
  pending(agent) { return this.s.requests.find((r) => r.status === "pending" && (!agent || r.agent === agent)); }
  fileOf(req) { return req.file ? `${sessionDir(this.id)}/${req.file}` : null; }

  // --- requests -----------------------------------------------------------------

  // `round`: a report is for its review's round, which a Retry after Loop
  // makes older than the session's.
  request(cx, kind, agent, ids, build, round = this.s.round) {
    const n = ++this.s.seq;
    // A review round writes no file: its report request (sent when it ends) does.
    const file = kind === "review" ? null : kind === "report" ? `findings-r${round}.json` : `${kind}-${n}.json`;
    const req = { n, kind, agent, ids, file, round, sent: false, status: "pending" };
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
    if (this.closed) return;
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
    req.waiting = false;
    cx.spawn(async (cx) => {
      try {
        const addr = this.s[req.agent];
        if (!req.sent) {
          // The agent may be mid-turn with something else: another session's
          // request, or the person's own prompt. Let it finish first.
          for (;;) {
            const st = statusOf(await hcJson(["get", addr]));
            if (st === null) return this.fail(req, `${WHO[req.agent]} (${addr}) is gone.`, cx);
            req.waiting = st === "working" || st === "blocked";
            cx.notify();
            if (st === "working") await hcJson(["wait", addr, "--timeout", "540"], 600000);
            else if (st === "blocked") await cx.sleep(2000);
            else break;
            if (req.status !== "pending") return;
          }
          req.waiting = false;
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
            if (st === null) break;
            // Started: after a reload or Retry, idle means it's done.
            if (st === "working" || st === "blocked") { req.launch = false; this.save(); break; }
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
          this.request(cx, "report", "reviewer", [], (path) => reportTask(this.s, req.round, path), req.round);
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
    req.waiting = false;
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
    if (!this.s || this.closed) return;
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
        // Only an explicit true: a missing or odd value shows as not fixed, with its note.
        const ok = x.fixed === true;
        // The instruction it was fixed with, for the reviewer's verify.
        f.fix = { ok, note: x.note ?? "", instruction: f.instruction ?? null };
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

  // A Triaged finding's instruction for the fix ("Create a Jira issue"…):
  // the field appears on first click; it's saved on blur and Enter.
  editInstruction(f, cx) {
    let st = this.inputs.get(f.id);
    if (!st) {
      st = InputState.new({ placeholder: "How to fix it (optional), e.g. Create a Jira issue", value: f.instruction ?? "" });
      st.on("change", (_e, cx) => { f.instruction = st.value().trim() || null; cx.notify(); });
      st.on("blur", () => { this.save(); });
      st.on("submit", () => { this.save(); });
      this.inputs.set(f.id, st);
    }
    st.focus();
    cx.notify();
  }

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

  // The checked findings that can be: done, without asking an agent.
  ignorable() { return this.s.findings.filter((f) => f.checked && IGNORABLE.has(f.state)); }

  ignore(cx) {
    for (const f of this.ignorable()) { f.ignoredFrom = f.state; f.state = "Ignored"; f.checked = false; }
    this.save();
    cx.notify();
  }

  // Back to where it was ignored from, checked again.
  restore(f, cx) {
    f.state = f.ignoredFrom ?? "New";
    delete f.ignoredFrom;
    f.checked = true;
    this.save();
    cx.notify();
  }

  // Done findings (verified or ignored) leave the list; they stay in the session (and its count).
  archiveDone(cx) {
    for (const f of this.s.findings) if (DONE.has(f.state)) f.archived = true;
    this.save();
    cx.notify();
  }

  // Asks first (the shipped confirm dialog), which sends archive-<id> back.
  confirmDone() {
    const s = this.s;
    const busy = s.requests.some((r) => r.status === "pending");
    openOverlay({ mod: "confirm", kind: "dialog", props: {
      title: "Finish this review?",
      detail: `Moves the session to the archive, ends the reviewer (${s.reviewer}) and closes this pane.` +
        (busy ? " Requests still in progress are dropped; an agent that's working carries on." : ""),
      command: { name: `leddt-review.archive-${cmdId(this.id)}` },
    } });
  }

  // The whole session: state saved one last time, the reviewer ended, the
  // folder moved to the archive, the pane closed.
  async archiveSession(cx) {
    if (this.closed) return;
    this.s.archived = Date.now();
    this.s.requests = this.s.requests.filter((r) => r.status !== "pending");
    await this.save();
    await this.saving;
    this.closed = true;
    if (this.alive(this.s.reviewer)) await exec("hc", ["kill", this.s.reviewer]).catch(() => null);
    const to = archiveDir(this.id);
    const mv = await exec("sh", ["-c", 'mkdir -p "$(dirname "$2")" && mv "$1" "$2"', "sh", sessionDir(this.id), to]).catch((e) => ({ code: 1, stderr: String(e) }));
    if (mv.code !== 0) {
      this.closed = false;
      notify({ title: "Review: couldn't archive the session", body: (mv.stderr || mv.stdout || "").trim(), level: "error" });
      cx.notify();
      return;
    }
    const map = { ...(shared(PANES) ?? {}) };
    const pane = map[this.id];
    delete map[this.id];
    setShared(PANES, map);
    notify({ title: "Review archived", body: to, level: "success" });
    if (pane && panes().some((x) => x.pane === pane)) run("pane.close", { pane });
    cx.notify();
  }

  // --- view ---------------------------------------------------------------------

  activity(req) {
    const n = req.ids?.length ?? 0, s = n === 1 ? "" : "s";
    if (req.blocked) return `${WHO[req.agent]} needs you (${this.s[req.agent]})`;
    if (req.waiting) return `Waiting for ${WHO[req.agent]} (${this.s[req.agent]}) to finish its current turn…`;
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
    if (this.closed) return div().size_full().p(16).bg(t.background).text_color(t.dim).child("This review is archived. You can close this pane.");
    const s = this.s;
    const alive = new Set(terminals().filter((x) => x.state === "live").map((x) => x.address));
    const reviewerBusy = Boolean(this.pending("reviewer")), originBusy = Boolean(this.pending("origin"));
    const toFix = this.picked("Triaged").length, toVerify = this.picked("Fixed").length, toTriage = this.picked("New").length;
    const total = s.findings.length, doneCount = s.findings.filter((f) => DONE.has(f.state)).length;
    const open = s.findings.filter((f) => !DONE.has(f.state));
    const toIgnore = this.ignorable().length;
    const allChecked = open.length > 0 && open.every((f) => f.checked);
    const shown = s.findings.filter((f) => !f.archived);
    const archived = total - shown.length;
    const toArchive = shown.filter((f) => DONE.has(f.state)).length;

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
          .child(div().text_size(11).text_color(t.dim).child((total ? `${doneCount}/${total} done · ` : "") + (archived ? `${archived} archived · ` : "") + `round ${s.round}`))
          .child(div().flex_1())
          .child(link("lr-go-origin", "Agent", s.origin))
          .child(link("lr-go-reviewer", "Reviewer", s.reviewer))
          .child(h_flex().id("lr-done").h(20).px(7).items_center().rounded(5).border_1().border_color(t.input).text_size(11)
            .text_color(t.muted).cursor_pointer().hover((st) => st.bg(t.hover).text_color(t.foreground))
            .tooltip("Finish: archive this review, end the reviewer, close this pane")
            .on_click(() => this.confirmDone())
            .child("Done")))
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
          .when(total > 0 && !shown.length, (el) => el.child(div().p(8).text_color(t.dim).child("Every finding is archived.")))
          .children(shown.map((f) => this.card(f, t)))))
      // Actions.
      .child(h_flex().flex_none().px(10).py(8).gap(6).items_center().border_t(1).border_color(t.border)
        .child(h_flex().id("lr-all").gap(6).items_center().cursor_pointer().text_size(11.5).text_color(t.muted)
          .on_click((_e, cx) => { for (const f of open) f.checked = !allChecked; this.save(); cx.notify(); })
          .child(this.box(allChecked, t)).child("All"))
        .when(toArchive > 0, (el) => el.child(button("lr-archive", `Archive done (${toArchive})`, true, false, (cx) => this.archiveDone(cx), "Hide the verified and ignored findings from the list")))
        .child(div().flex_1())
        .when(toIgnore > 0, (el) => el.child(button("lr-ignore", `Ignore (${toIgnore})`, true, false, (cx) => this.ignore(cx), "Mark the checked findings as ignored: done, without a fix")))
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

  instructionField(f, t) {
    const st = this.inputs.get(f.id);
    const frame = div().id(`lr-ins-${f.id}`).ml(22).h(28).px(8).flex().items_center().rounded(6).border_1()
      .border_color(t.input).bg(t.background).cursor_text();
    if (st) return frame.child(Input.new(st).h_full().w_full().text_size(12).text_color(t.foreground));
    return frame.on_click((_e, cx) => { cx.stop_propagation(); this.editInstruction(f, cx); })
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(f.instruction ? t.foreground : t.dim)
        .child(f.instruction ?? "How to fix it (optional), e.g. Create a Jira issue"));
  }

  badge(text, color, t, spin) {
    return h_flex().flex_none().h(18).px(6).gap(4).items_center().rounded(5).bg(color + "22").text_size(10.5).font_semibold().text_color(color)
      .when(Boolean(spin), (el) => el.child(svg("mods/leddt-review/spinner.svg").size(9).spin(900)))
      .child(text);
  }

  card(f, t) {
    const done = DONE.has(f.state);
    const busy = Boolean(BUSY_BACK[f.state]);
    const stateColor = { New: t.muted, Triaging: t.working, Triaged: t.accent, Fixing: t.working, Fixed: t.done, Verifying: t.working, Verified: t.dim, Ignored: t.dim }[f.state] ?? t.muted;
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
            .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(where)))
            .when(f.state === "Ignored", (el) => el.child(div().id(`lr-restore-${f.id}`).px(5).h(18).flex().items_center().rounded(5)
              .text_size(10.5).text_color(t.muted).cursor_pointer().hover((st) => st.bg(t.hover).text_color(t.foreground))
              .tooltip(`Put it back to ${f.ignoredFrom ?? "New"}`)
              .on_click((_e, cx) => { cx.stop_propagation(); this.restore(f, cx); })
              .child("Restore"))))
          .when(Boolean(f.triage?.recommendation), (el) => el.child(div().text_size(12).text_color(t.foreground).whitespace_normal()
            .child(`→ ${f.triage.recommendation}`)))
          .when(Boolean(f.note) || f.verify?.ok === false || f.fix?.ok === false, (el) => el.child(div().text_size(11.5).text_color(t.blocked).whitespace_normal()
            .child(f.verify?.ok === false ? `Verify: not fixed. ${f.verify.note}` : f.fix?.ok === false ? `Not fixed: ${f.fix.note}` : f.note)))))
      // Triaged: the person's instruction for the fix, sent with it.
      .when(f.state === "Triaged", (el) => el.child(this.instructionField(f, t)))
      .when(f.state !== "Triaged" && !done && Boolean(f.instruction ?? f.fix?.instruction), (el) => el.child(div().pl(22).text_size(11.5).text_color(t.muted).whitespace_normal()
        .child(`Instruction: ${f.instruction ?? f.fix.instruction}`)))
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
