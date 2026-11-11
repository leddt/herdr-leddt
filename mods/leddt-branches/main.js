// The repo's branches, local then one group per remote, each with how many
// commits it is ahead of and behind the checked-out branch. Hovering a branch
// shows its actions (checkout, merge, rebase, rename, delete); a click selects
// it as the start of a new branch, a double-click checks it out. The header
// fetches, pulls and pushes; the bottom box creates a branch.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, notify, openOverlay, nextCommand } from "herdr";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const ps = panes(), pane = f?.pane ? ps.find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  // A mod pane (leddt-review's Findings…) has no folder: its tab's first terminal's.
  const tabCwd = pane?.mod ? ps.find(p => p.tab === pane.tab && p.terminal && p.cwd)?.cwd : null;
  return { cwd: pane?.cwd || tabCwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
// No terminal here: a merge or rebase that wants an editor takes its default message.
const WRITE = ["-c", "core.editor=true"];
const NETWORK = 120000;
const plural = (n) => `${n} commit${n === 1 ? "" : "s"}`;

// Every branch from one for-each-ref: a process per branch is ~0.2s each on
// Windows. %(ahead-behind:HEAD) needs git 2.41 and a commit to compare with;
// without either the list still shows, with no counts. The worktree path comes
// last: it's the only field that could hold a tab.
const format = (counted) => ["%(refname)", "%(HEAD)", counted ? "%(ahead-behind:HEAD)" : "", "%(upstream:short)", "%(upstream:track,nobracket)", "%(symref)", "%(committerdate:relative)", "%(worktreepath)"].join("%09");

function parse(out, remotes, counted) {
  const list = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [ref, head, ab, upstream, track, symref, date, ...path] = line.split("\t");
    if (symref) continue; // origin/HEAD
    const [ahead, behind] = counted && ab ? ab.split(" ").map(Number) : [null, null];
    const b = { ref, ahead, behind, date };
    if (ref.startsWith("refs/heads/")) {
      const current = head === "*";
      list.push({
        ...b, name: ref.slice(11), short: ref.slice(11), remote: null, current,
        upstream: upstream || null, gone: track === "gone",
        up: { ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0), behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0) },
        // Checked out in another worktree: git refuses to switch to it or delete it.
        elsewhere: !current && path.join("\t") ? path.join("\t") : null,
      });
    } else if (ref.startsWith("refs/remotes/")) {
      const short = ref.slice(13);
      // A remote's name may hold a slash: the longest one that fits.
      const remote = remotes.filter((r) => short.startsWith(`${r}/`)).sort((a, z) => z.length - a.length)[0] ?? short.split("/")[0];
      const name = short.slice(remote.length + 1);
      if (name) list.push({ ...b, name, short, remote, current: false });
    }
  }
  return list;
}

export default class Branches extends View {
  init(_props, cx) {
    this.branches = []; this.remotes = []; this.handle = cx.focus_handle();
    // Folded groups, kept across restarts. Remotes start folded.
    try { this.folds = JSON.parse(localStorage.getItem("folds") ?? "{}"); } catch { this.folds = {}; }
    this.name = "";
    this.input = InputState.new({ placeholder: "New branch name" });
    this.input.on("change", (_e, cx) => {
      const had = Boolean(this.name.trim());
      this.name = this.input.value();
      if (had !== Boolean(this.name.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.create(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.renameInput = InputState.new({ placeholder: "New name" });
    this.renameInput.on("submit", (_e, cx) => this.rename(cx));
    // The shipped confirm dialog sends "confirm" back; what it confirms waits in this.pending.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c !== "confirm" || !this.pending) continue;
        const go = this.pending;
        this.pending = null;
        go(cx);
        cx.notify();
      }
    });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  // The repo's own git folder (a worktree shares it): refs, HEAD and fetches land there.
  watch(dir, cx) {
    if (this.on || this.watched === dir) return;
    this.watched = dir;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === dir) {
          await watchFolder(dir);
          if (this.watched === dir) this.refresh(cx);
        }
      } catch { if (this.watched === dir) this.watched = null; }
    });
  }

  refresh(cx) {
    // Asked while busy: once more when that ends, so nothing it changed is missed.
    if (this.loading || this.busy) { this.again = true; return; }
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.branches = []; this.remotes = []; this.current = null; this.head = null;
      this.selected = null; this.renaming = null; this.pending = null; this.error = null; this.note = null; this.watched = null;
    }
    if (!cwd) return;
    this.loading = true; this.again = false;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.branches = []; this.selected = null; this.error = "Not a git repository"; return; }
        const root = top.stdout.replace(/\n$/, ""), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const refs = (counted) => git(["for-each-ref", "--sort=-committerdate", `--format=${format(counted)}`, "refs/heads", "refs/remotes"]);
        const [common, remote, head, first] = await Promise.all([
          git(["rev-parse", "--path-format=absolute", "--git-common-dir"]), git(["remote"]), git(["rev-parse", "--short", "HEAD"]), refs(true),
        ]);
        const counted = first.code === 0, listed = counted ? first : await refs(false);
        if (listed.code !== 0) throw new Error(listed.stderr.trim());
        if (key() !== context) return;
        const remotes = remote.code === 0 ? remote.stdout.split("\n").filter(Boolean) : [];
        this.root = root; this.on = on; this.remotes = remotes; this.error = null;
        this.branches = parse(listed.stdout, remotes, counted);
        this.current = this.branches.find((b) => b.current) ?? null;
        this.head = head.code === 0 ? head.stdout.trim() : null;
        if (this.selected && !this.branches.some((b) => b.ref === this.selected)) { this.selected = null; this.renaming = null; }
        if (common.code === 0) this.watch(common.stdout.replace(/\n$/, ""), cx);
        this.loadDetail(cx);
      } catch (e) { if (key() === context) this.error = String(e?.message ?? e); }
      finally {
        this.loading = false;
        if (this.again) this.refresh(cx);
        cx.notify();
      }
    });
  }

  // The selected branch's last commit, and the commits the other side lacks: the
  // checked-out branch's for any other branch, its upstream's for the checked-out one.
  loadDetail(cx) {
    const b = this.branches.find((x) => x.ref === this.selected);
    if (!b || !this.root) { this.detail = null; return; }
    // The same branch keeps what it showed until the new read lands.
    if (this.detail?.ref !== b.ref) this.detail = null;
    const root = this.root, on = this.on, context = this.context, ref = b.ref;
    const range = b.current ? (b.upstream && !b.gone ? `${b.upstream}..${ref}` : null) : `HEAD..${ref}`;
    cx.spawn(async (cx) => {
      try {
        const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const [tip, log] = await Promise.all([
          git(["log", "-1", "--date=format:%Y-%m-%d %H:%M", "--format=%h%x09%an%x09%ad%x09%ar%x09%s", ref]),
          range ? git(["log", "-n", "6", "--format=%h%x09%s", range]) : null,
        ]);
        if (key() !== context || this.selected !== ref || tip.code !== 0) return;
        const [sha, author, date, ago, ...subject] = tip.stdout.replace(/\n$/, "").split("\t");
        const commits = log?.code === 0 ? log.stdout.split("\n").filter(Boolean).map((l) => { const [h, ...s] = l.split("\t"); return { sha: h, subject: s.join("\t") }; }) : [];
        this.detail = { ref, sha, author, date, ago, subject: subject.join("\t"), commits };
        cx.notify();
      } catch {}
    });
  }

  // One git action at a time. `work` gets git(args, timeout), which throws git's own message on failure.
  act(cx, label, work) {
    if (this.busy || !this.root || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context;
    const git = async (args, timeout) => {
      const r = await exec("git", [...WRITE, ...args], { cwd: root, on, ...(timeout ? { timeout } : {}) });
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `git ${args[0]} failed`);
      return r.stdout.trim();
    };
    this.busy = label; this.note = null;
    cx.spawn(async (cx) => {
      try { await work(git); }
      catch (e) { if (key() === context) this.note = `${label} failed: ${e?.message ?? e}`; }
      finally { this.busy = null; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  ask(title, detail, go) {
    this.pending = go;
    openOverlay({ mod: "confirm", kind: "dialog", props: { title, detail, command: { name: "leddt-branches.confirm" } } });
  }

  // What the checked-out side is called in a sentence.
  here() { return this.current?.name ?? (this.head ? `HEAD (${this.head})` : "HEAD"); }

  checkout(b, cx) {
    if (b.current || b.elsewhere) return;
    // A remote branch: its local branch if there is one, else a new one that tracks it.
    const local = b.remote ? this.branches.find((x) => !x.remote && x.name === b.name) : b;
    if (local?.elsewhere) { this.note = `${local.name} is checked out in another worktree: ${local.elsewhere}`; cx.notify(); return; }
    this.act(cx, "Checkout", (git) => git(local ? ["switch", local.name] : ["switch", "--track", b.short]));
  }

  create(cx) {
    const name = this.name.trim();
    if (!name || this.busy) return;
    const from = this.branches.find((b) => b.ref === this.selected);
    this.act(cx, "Create", async (git) => {
      try { await git(["check-ref-format", "--branch", name]); }
      catch { throw new Error(`"${name}" is not a valid branch name`); }
      // No upstream from a remote start point: the first Push sets its own.
      await git(["switch", "--no-track", "-c", name, ...(from ? [from.ref] : [])]);
      this.name = ""; this.input.set_value(""); this.selected = null;
    });
  }

  startRename(b, cx) {
    this.renaming = b.ref; this.selected = b.ref; this.loadDetail(cx);
    this.renameInput.set_value(b.name);
    this.renameInput.focus();
    cx.notify();
  }

  rename(cx) {
    const b = this.branches.find((x) => x.ref === this.renaming), name = this.renameInput.value().trim();
    if (!b || !name || name === b.name) { this.renaming = null; cx.notify(); return; }
    this.act(cx, "Rename", async (git) => {
      await git(["branch", "-m", b.name, name]);
      this.renaming = null; this.selected = `refs/heads/${name}`;
    });
  }

  remove(b, cx) {
    if (b.remote) {
      this.ask(`Delete ${b.short} on the remote?`, `Runs git push ${b.remote} --delete ${b.name}. The branch is removed from ${b.remote} for everyone. Local branches stay.`,
        (cx) => this.act(cx, "Delete", (git) => git(["push", b.remote, "--delete", b.name], NETWORK)));
      return;
    }
    const go = (cx) => this.act(cx, "Delete", async (git) => {
      try { await git(["branch", "-d", b.name]); }
      catch (e) {
        if (!/not fully merged/i.test(String(e?.message))) throw e;
        this.ask(`${b.name} is not fully merged. Delete it anyway?`, `Its commits that are on no other branch are dropped (git branch -D ${b.name}).`,
          (cx) => this.act(cx, "Delete", (git) => git(["branch", "-D", b.name])));
      }
    });
    // Its remote branch is gone and the checked-out branch has all its commits: nothing to lose, no question.
    if (b.gone && b.ahead === 0) return go(cx);
    this.ask(`Delete branch ${b.name}?`, "Deletes the local branch. If it has commits that aren't merged, you'll be asked again before they are dropped.", go);
  }

  merge(b) {
    this.ask(`Merge ${b.short} into ${this.here()}?`, `Runs git merge --no-edit ${b.short}. A conflict leaves the merge in progress: finish or abort it in a terminal.`,
      // The short name: git puts what it was given in the merge commit's message.
      (cx) => this.act(cx, "Merge", (git) => git(["merge", "--no-edit", b.short])));
  }

  rebase(b) {
    this.ask(`Rebase ${this.here()} onto ${b.short}?`, `Runs git rebase ${b.short}: rewrites the commits of ${this.here()} that ${b.short} lacks. A conflict leaves the rebase in progress: finish or abort it in a terminal.`,
      (cx) => this.act(cx, "Rebase", (git) => git(["rebase", b.ref])));
  }

  fetch(cx) {
    this.act(cx, "Fetch", async (git) => {
      await git(["fetch", "--all", "--prune"], NETWORK);
      notify({ title: "Branches", body: "Fetched every remote", level: "success" });
    });
  }

  pull(cx) {
    const b = this.current;
    if (!b?.upstream || b.gone) return;
    this.act(cx, "Pull", async (git) => {
      await git(["pull"], NETWORK);
      notify({ title: "Branches", body: `Pulled ${b.name} from ${b.upstream}`, level: "success" });
    });
  }

  // Where a branch with no upstream is pushed: origin, else the only other choice.
  pushRemote() { return this.remotes.includes("origin") ? "origin" : this.remotes[0] ?? null; }

  push(cx) {
    const b = this.current, tracked = b?.upstream && !b.gone, remote = this.pushRemote();
    if (!b || (!tracked && !remote)) return;
    this.act(cx, "Push", async (git) => {
      await git(tracked ? ["push"] : ["push", "-u", remote, b.name], NETWORK);
      notify({ title: "Branches", body: tracked ? `Pushed ${b.name} to ${b.upstream}` : `Pushed ${b.name} to ${remote} and set it as upstream`, level: "success" });
    });
  }

  folded(group) { return this.folds[group] ?? group !== "local"; }

  toggle(group) {
    this.folds[group] = !this.folded(group);
    try { localStorage.setItem("folds", JSON.stringify(this.folds)); } catch {}
  }

  click(e, b, cx) {
    if (e.click_count === 2) { this.selected = b.ref; this.checkout(b, cx); cx.notify(); return; }
    this.selected = this.selected === b.ref ? null : b.ref;
    this.renaming = null;
    this.loadDetail(cx);
    cx.notify();
  }

  chip(t, text) {
    return div().flex_none().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(text);
  }

  // ↑ commits the branch has that the other side lacks, ↓ commits it lacks.
  counts(t, ahead, behind) {
    const el = h_flex().flex_none().gap(5).text_size(11);
    if (!ahead && !behind) return el.child(div().text_color(t.dim).child("="));
    return el.when(ahead > 0, (e) => e.child(div().text_color(t.ansi2).child(`↑${ahead}`))).when(behind > 0, (e) => e.child(div().text_color(t.ansi1).child(`↓${behind}`)));
  }

  row(b, t) {
    // Under the pointer, the branch's actions take the place of its date and counts.
    const hot = this.hover === b.ref && !this.busy && this.renaming !== b.ref;
    return h_flex().id(`branch-${b.ref}`).h(28).flex_none().pl(10).pr(8).gap(8).items_center().rounded(7).cursor_pointer()
      .when(this.selected === b.ref, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_hover((hovered, cx) => { if (hovered) this.hover = b.ref; else if (this.hover === b.ref) this.hover = null; cx.notify(); })
      .on_click((e, cx) => this.click(e, b, cx))
      .child(div().w(6).flex_none().when(b.current, (e) => e.h(6).rounded(3).bg(t.accent)))
      .child(div().flex_1().min_w(0).truncate().when(b.current, (e) => e.font_semibold()).child(b.name))
      .when(b.current, (e) => e.child(this.chip(t, "current")))
      .when(Boolean(b.elsewhere), (e) => e.child(this.chip(t, "worktree").id(`worktree-${b.ref}`).tooltip(`Checked out in ${b.elsewhere}`)))
      .when(Boolean(b.gone), (e) => e.child(this.chip(t, "upstream gone")))
      .when(hot, (e) => e.child(this.buttons(b, t)))
      .when(!hot && !b.current && !b.elsewhere && !b.gone, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(b.date)))
      // The checked-out branch has nothing to compare with but its upstream: what Pull and Push would move.
      .when(!hot && b.current && Boolean(b.upstream) && !b.gone, (e) => e.child(this.counts(t, b.up.ahead, b.up.behind)))
      .when(!hot && b.current && !b.upstream, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child("no upstream")))
      .when(!hot && !b.current && b.ahead !== null, (e) => e.child(this.counts(t, b.ahead, b.behind)));
  }

  // What can be done with a branch, as icons at the end of its row.
  buttons(b, t) {
    const item = (icon, tip, act, danger) => div().id(`${icon}-${b.ref}`).size(22).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
      .text_color(danger ? t.ansi1 : t.muted).hover((s) => s.bg(t.selected).text_color(danger ? t.ansi1 : t.foreground)).tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); act(cx); cx.notify(); })
      .child(svg(`mods/leddt-branches/${icon}.svg`).size(14));
    const here = this.here(), other = !b.current;
    return h_flex().flex_none().gap(1).items_center()
      .when(other && !b.elsewhere, (e) => e.child(item("checkout", b.remote ? `Checkout: switch to ${b.name}, creating it from ${b.short} if needed` : `Checkout: switch to ${b.name}`, (cx) => this.checkout(b, cx))))
      .when(other, (e) => e.child(item("merge", `Merge ${b.short} into ${here}`, () => this.merge(b))))
      .when(other, (e) => e.child(item("rebase", `Rebase ${here} onto ${b.short}`, () => this.rebase(b))))
      .when(!b.remote, (e) => e.child(item("rename", `Rename ${b.name}`, (cx) => this.startRename(b, cx))))
      .when(other && !b.elsewhere, (e) => e.child(item("delete", b.remote ? `Delete ${b.name} on ${b.remote}` : `Delete ${b.name}`, (cx) => this.remove(b, cx), true)));
  }

  // Above the new-branch box while a branch is selected: what it tracks, how it
  // compares, its last commit and the first commits the other side lacks.
  details(b, t) {
    const d = this.detail?.ref === b.ref ? this.detail : null, here = this.here();
    const line = (text, color) => div().truncate().text_color(color ?? t.muted).child(text);
    const commit = (c, color) => h_flex().gap(6)
      .child(div().flex_none().text_color(color).child(c.sha)).child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(c.subject));
    const lines = [];
    if (b.remote) lines.push(line(`Remote branch on ${b.remote}`));
    else if (b.gone) lines.push(line(`Upstream ${b.upstream} is gone`, t.blocked));
    else if (b.upstream) lines.push(line(`Tracks ${b.upstream}: ${b.up.ahead || b.up.behind ? `${plural(b.up.ahead)} to push, ${plural(b.up.behind)} to pull` : "nothing to push or pull"}`));
    else lines.push(line("No upstream"));
    if (b.current) lines.push(line("Checked out here"));
    else if (b.ahead !== null) lines.push(line(b.ahead || b.behind ? `${plural(b.ahead)} ahead of ${here}, ${plural(b.behind)} behind` : `Same commits as ${here}`));
    if (b.elsewhere) lines.push(line(`Checked out in ${b.elsewhere}`));
    if (d) {
      lines.push(div().mt(4).text_color(t.dim).child("Last commit"));
      lines.push(commit(d, t.accent));
      lines.push(line(`${d.author} · ${d.date} (${d.ago})`));
      if (d.commits.length) {
        lines.push(div().mt(4).truncate().text_color(t.dim).child(b.current ? `Not pushed to ${b.upstream}` : `Not on ${here}`));
        lines.push(...d.commits.slice(0, 5).map((c) => commit(c, t.muted)));
        if (d.commits.length > 5) lines.push(line("…and more", t.dim));
      }
    } else lines.push(line("Loading…", t.dim));
    return v_flex().flex_none().px(12).py(8).gap(2).border_t(1).border_color(t.border).text_size(11.5)
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_semibold().child(b.short))
        .child(div().id("detail-close").size(20).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer().text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Clear the selection")
          .on_click((_e, cx) => { this.selected = null; this.renaming = null; this.detail = null; cx.notify(); })
          .child(svg("mods/pane/close.svg").size(12))))
      .children(lines);
  }

  // Under the row being renamed.
  renameBox(t) {
    return h_flex().ml(24).mr(8).mb(4).p(3).gap(2).items_center().rounded(7).border_1().border_color(t.border).bg(t.popover)
      .child(div().id("rename-box").flex_1().min_w(0).h(24).px(8).flex().items_center().rounded(5).border_1().border_color(t.accent).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.renameInput).h_full().text_size(12).text_color(t.foreground)))
      .child(div().flex_none().px(6).text_size(10.5).text_color(t.dim).child("Enter to rename · Esc"));
  }

  group(id, label, items, t) {
    const closed = this.folded(id);
    const head = h_flex().id(`group-${id}`).h(26).flex_none().px(6).gap(6).items_center().rounded(7).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.toggle(id); cx.notify(); })
      .child(svg(`mods/leddt-changes/${closed ? "chevron-right" : "chevron-down"}.svg`).size(12).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().child(label))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(String(items.length)));
    if (closed) return [head];
    return [head, ...items.flatMap((b) => this.renaming === b.ref ? [this.row(b, t), this.renameBox(t)] : [this.row(b, t)])];
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), cur = this.current;
    const locals = this.branches.filter((b) => !b.remote);
    const remotes = [...new Set(this.branches.filter((b) => b.remote).map((b) => b.remote))].sort();
    const from = this.branches.find((b) => b.ref === this.selected);
    const ready = Boolean(this.root && !this.busy);
    const canCreate = ready && Boolean(this.name.trim());
    const canPull = ready && Boolean(cur?.upstream) && !cur.gone;
    const canPush = ready && Boolean(cur) && Boolean((cur.upstream && !cur.gone) || this.pushRemote());
    const button = (id, label, tip, on, act) => div().id(id).h(24).px(8).flex_none().flex().items_center().rounded(6).text_size(11.5)
      .text_color(on ? t.muted : t.dim).tooltip(tip)
      .when(on, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => act(cx)))
      .child(label);
    return v_flex().id("branches").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        if (this.renaming) this.renaming = null;
        else if (!this.typing) return;
        this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify();
      })
      .child(h_flex().h(42).flex_none().px(14).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Branches"))
        .child(this.chip(t, `${locals.length} local`))
        .when(Boolean(this.busy), (e) => e.child(svg("mods/workspace-chrome/spinner.svg").size(13).flex_none().text_color(t.working).spin(900))
          .child(div().text_size(11).text_color(t.dim).child(`${this.busy}…`)))
        .child(div().flex_1())
        .child(button("branches-fetch", "Fetch", "Fetch every remote and drop branches deleted there (git fetch --all --prune)", ready, (cx) => this.fetch(cx)))
        .child(button("branches-pull", "Pull", cur?.upstream && !cur.gone ? `Pull ${cur.name} from ${cur.upstream}` : "The checked-out branch has no upstream to pull from", canPull, (cx) => this.pull(cx)))
        .child(button("branches-push", "Push", !cur ? "No branch is checked out" : cur.upstream && !cur.gone ? `Push ${cur.name} to ${cur.upstream}` : this.pushRemote() ? `Push ${cur.name} to ${this.pushRemote()} and set it as upstream` : "No remote to push to", canPush, (cx) => this.push(cx))))
      .when(Boolean(this.root && !cur && this.head), (e) => e.child(div().flex_none().px(14).py(5).text_size(11).text_color(t.blocked).border_b(1).border_color(t.border).child(`Detached HEAD at ${this.head}: counts compare with that commit`)))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("branches-list").absolute().inset_0().overflow_y_scroll().p(6)
          .when(Boolean(this.root), (e) => e.children(this.group("local", "Local", locals, t))
            .children(remotes.flatMap((r) => this.group(`remote:${r}`, r, this.branches.filter((b) => b.remote === r), t))))
          .when(!this.root, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading branches…" : "No folder")))))
        .child(Scrollbar.vertical("branches-list").absolute().inset_0()))
      .when(Boolean(this.root && this.error), (e) => e.child(div().px(10).pt(6).text_size(11).text_color(t.ansi1).child(this.error)))
      .when(Boolean(this.note), (e) => e.child(div().px(10).py(6).text_size(11).text_color(t.ansi1).child(this.note)))
      .when(Boolean(from), (e) => e.child(this.details(from, t)))
      .child(v_flex().flex_none().p(10).gap(6).border_t(1).border_color(t.border)
        .child(div().text_size(11).text_color(t.dim).truncate().child(`New branch from ${from ? from.short : this.here()}${from ? "" : " (select a branch to start from it)"}`))
        .child(h_flex().gap(8)
          .child(div().id("branch-name").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text()
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
          .child(div().id("branch-create").h(32).px(14).flex().items_center().rounded(8).bg(canCreate ? t.solid : t.raised).text_color(canCreate ? t.solid_foreground : t.dim).text_size(12)
            .when(canCreate, (e) => e.cursor_pointer()).on_click((_e, cx) => this.create(cx)).child(this.busy === "Create" ? "Creating…" : "Create"))));
  }
}
