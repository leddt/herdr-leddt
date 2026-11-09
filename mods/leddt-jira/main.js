// Jira issues assigned to me that aren't done, grouped by project.
// Asks the twg CLI (already signed in to Atlassian), so the mod holds no token.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, exec, panes } from "herdr";
import { ACTIONS, FALLBACK_AGENT, installedAgents, visibleAgents, writePrompt } from "./agent.js";

const JQL = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";
const FIELDS = "summary,status,project,issuetype,updated";
const PAGES = 5; // 100 issues per page
// In-progress first, then to do, then anything else.
const CATEGORY_ORDER = { indeterminate: 0, new: 1 };
// The filter bars, top to bottom: the issue field each one filters on, and where its choice is kept.
const FILTERS = {
  status: { label: "Statut", storage: "hiddenStatuses" },
  type: { label: "Type", storage: "hiddenTypes" },
};

// One page of `twg jira workitem query`. (--select would drop pageInfo, so the full payload.)
async function page(after) {
  const args = ["jira", "workitem", "query", "--jql", JQL, "--fields", FIELDS, "--limit", "100",
    "-o", "json", "--output-summary", "none", ...(after ? ["--after", after] : [])];
  let r;
  try { r = await exec("twg", args, { timeout: 60000 }); }
  catch (e) { throw new Error(String(e).includes("not found") ? "twg introuvable dans le PATH" : String(e?.message ?? e)); }
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout || "").split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? `code ${r.code}`;
    throw new Error(`twg : ${msg}`);
  }
  return JSON.parse(r.stdout);
}

async function search() {
  const issues = [];
  let after;
  for (let i = 0; i < PAGES; i++) {
    const data = await page(after);
    issues.push(...(data.data?.issues ?? []));
    after = data.pageInfo?.hasNextPage ? data.pageInfo.nextCursor : null;
    if (!after) break;
  }
  return issues.map(i => ({
    key: i.key,
    url: i.url,
    summary: i.summary ?? i.fields?.summary ?? "",
    status: i.status?.name ?? "",
    category: i.status?.statusCategory?.key ?? "",
    type: i.issuetype?.name ?? "",
    project: { key: i.project?.key ?? "?", name: i.project?.name ?? "?" },
    updated: i.updated ? Date.parse(i.updated) : 0,
  }));
}

// Status order: the person's dragged order first, then any status it doesn't know yet,
// in progress first, then to do, then by name. `order` is a list of status names.
function statusCompare(order) {
  const rank = s => CATEGORY_ORDER[s.category] ?? 2;
  return (a, b) => {
    const ia = order.indexOf(a.name), ib = order.indexOf(b.name);
    if (ia >= 0 || ib >= 0) return ia < 0 ? 1 : ib < 0 ? -1 : ia - ib;
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  };
}

function groups(issues, order) {
  const byProject = new Map();
  for (const i of issues) {
    if (!byProject.has(i.project.key)) byProject.set(i.project.key, { ...i.project, issues: [] });
    byProject.get(i.project.key).issues.push(i);
  }
  // Inside a project, one sub-group per status, in the status bar's order.
  const compare = statusCompare(order);
  for (const g of byProject.values()) {
    const byStatus = new Map();
    for (const i of g.issues) {
      if (!byStatus.has(i.status)) byStatus.set(i.status, { name: i.status, category: i.category, issues: [] });
      byStatus.get(i.status).issues.push(i);
    }
    for (const s of byStatus.values()) s.issues.sort((a, b) => b.updated - a.updated);
    g.statuses = [...byStatus.values()].sort(compare);
  }
  return [...byProject.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export default class Jira extends View {
  init(_props, cx) {
    this.issues = null;
    this.error = null;
    this.loading = false;
    try { this.collapsed = new Set(JSON.parse(localStorage.getItem("collapsed") ?? "[]")); }
    catch { this.collapsed = new Set(); }
    // The status order the person dragged, by name; the status chip being dragged and the one under it.
    try { this.statusOrder = JSON.parse(localStorage.getItem("statusOrder") ?? "[]"); }
    catch { this.statusOrder = []; }
    this.drag = null;
    this.dragOver = null;
    this.ghost = null; // { label, dot, on, grab, start, at }: the copy of the dragged chip
    this.hoverKey = null; // the issue row under the pointer: it shows the agent buttons
    this.picking = null; // { key, action }: choosing where the prompt goes
    this.installed = []; // knownAgents() installed here, most picked first: for new tabs
    this.sending = null; // the issue whose prompt is being written
    this.copied = null; // the issue whose key was just copied: its icon shows a check
    // Statuses and issue types (by name, across projects) the person chose not to see.
    this.hidden = {};
    for (const kind of Object.keys(FILTERS)) {
      try { this.hidden[kind] = new Set(JSON.parse(localStorage.getItem(FILTERS[kind].storage) ?? "[]")); }
      catch { this.hidden[kind] = new Set(); }
    }
    this.refresh(cx);
    cx.timer.every(120000, cx => this.refresh(cx));
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.notify();
    cx.spawn(async cx => {
      try {
        this.issues = await search();
        this.error = null;
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.loading = false;
      cx.notify();
    });
    // Which agents a new tab can start (Herdr asks at most once a minute).
    cx.spawn(async cx => {
      try { this.installed = await installedAgents(); cx.notify(); } catch { /* keep the last list */ }
    });
  }

  toggle(key) {
    if (this.collapsed.has(key)) this.collapsed.delete(key); else this.collapsed.add(key);
    localStorage.setItem("collapsed", JSON.stringify([...this.collapsed]));
  }

  setHidden(kind, names) {
    this.hidden[kind] = new Set(names);
    localStorage.setItem(FILTERS[kind].storage, JSON.stringify([...this.hidden[kind]]));
  }

  // Whether an issue passes every filter, or every filter but `except`.
  passes(i, except) {
    return Object.keys(FILTERS).every(kind => kind === except || !this.hidden[kind].has(i[kind]));
  }

  // Drops the dragged status chip on `target`: it takes target's place, so dragging
  // right lands after it and dragging left before it. Statuses not shown keep their places.
  moveStatus(names, dragged, target) {
    const list = [...names];
    const from = list.indexOf(dragged), to = list.indexOf(target);
    if (from < 0 || to < 0 || from === to) return;
    list.splice(from, 1);
    list.splice(to, 0, dragged);
    this.statusOrder = [...list, ...this.statusOrder.filter(n => !list.includes(n))];
    localStorage.setItem("statusOrder", JSON.stringify(this.statusOrder));
  }

  // One chip per value of `kind` in the results; a click shows or hides it. A chip's
  // count is the issues it would show given the other filters. Status chips also drag
  // to reorder (press on one, release on another), which orders the sub-groups too.
  filterBar(t, kind) {
    const values = new Map();
    for (const i of this.issues ?? []) {
      const v = values.get(i[kind]) ?? { name: i[kind], category: i.category, count: 0 };
      if (this.passes(i, kind)) v.count++;
      values.set(i[kind], v);
    }
    if (values.size === 0) return null;
    const hidden = this.hidden[kind];
    const draggable = kind === "status";
    const sorted = [...values.values()].sort(draggable ? statusCompare(this.statusOrder) : (a, b) => a.name.localeCompare(b.name));
    const names = sorted.map(v => v.name);
    const chip = (id, on, label, dot, action) =>
      h_flex().id(id).h(22).px(8).gap(5).flex_none().items_center().rounded(11).text_size(11)
        .border(1).border_color(on ? t.border : t.surface).bg(on ? t.raised : t.surface)
        .text_color(on ? t.foreground : t.dim).hover(s => s.bg(t.hover)).cursor_pointer()
        .on_click((_e, cx) => { action(); cx.notify(); })
        .when(!!dot, el => el.child(div().size(6).rounded(3).flex_none().bg(dot).opacity(on ? 1 : 0.4)))
        .child(label);
    // A status chip: a press starts a drag; releasing on the same chip is a click (show/hide),
    // on another chip a move. While dragging, the dragged chip fades and the target is outlined.
    const statusChip = (v, on, toggle) => {
      const dragging = this.drag === v.name;
      const target = this.drag && !dragging && this.dragOver === v.name;
      return chip(`${kind}-${v.name}`, on, `${v.name} ${v.count}`, this.dot(t, v.category), () => {})
        .when(dragging, el => el.opacity(0.45))
        .when(target, el => el.border_color(t.accent))
        .on_mouse_down("left", (e, cx) => {
          this.drag = v.name; this.dragOver = v.name;
          // The ghost keeps the point where the chip was grabbed under the pointer.
          const grab = e.local_position ?? { x: 12, y: 11 };
          this.ghost = { label: `${v.name} ${v.count}`, dot: this.dot(t, v.category), on, grab, start: null, at: null };
          cx.notify();
        })
        .on_hover((hovered, cx) => {
          if (!this.drag || !hovered || this.dragOver === v.name) return;
          this.dragOver = v.name;
          cx.notify();
        })
        .on_mouse_up("left", (_e, cx) => {
          const dragged = this.drag;
          this.drag = this.dragOver = this.ghost = null;
          if (dragged && dragged !== v.name) this.moveStatus(names, dragged, v.name);
          else if (dragged) toggle();
          cx.notify();
        });
    };
    return h_flex().id(`bar-${kind}`).flex_none().flex_wrap().items_center().gap(4).px(10).py(6).border_b(1).border_color(t.border)
      .child(div().w(44).flex_none().text_size(10.5).text_color(t.dim).child(FILTERS[kind].label))
      .children(sorted.map(v => {
        const on = !hidden.has(v.name);
        const toggle = () => {
          const next = new Set(hidden);
          if (on) next.add(v.name); else next.delete(v.name);
          this.setHidden(kind, next);
        };
        return draggable ? statusChip(v, on, toggle) : chip(`${kind}-${v.name}`, on, `${v.name} ${v.count}`, this.typeColor(t, v.name), toggle);
      }));
  }

  // Whether any bar hides something or the statuses have a dragged order.
  filtered() {
    return this.statusOrder.length > 0 || Object.values(this.hidden).some(s => s.size > 0);
  }

  // Shows every status and type again and goes back to the automatic status order.
  resetFilters() {
    for (const kind of Object.keys(FILTERS)) this.setHidden(kind, []);
    this.statusOrder = [];
    localStorage.setItem("statusOrder", "[]");
  }

  dot(t, category) {
    return category === "indeterminate" ? t.working : category === "done" ? t.done : t.idle;
  }

  header(t) {
    const total = this.issues?.length;
    const shown = this.issues?.filter(i => this.passes(i)).length;
    const count = total == null ? null : shown === total ? String(total) : `${shown} / ${total}`;
    return h_flex().h(36).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
      .child(svg("mods/leddt-jira/jira.svg").size(14).text_color(t.muted))
      .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child("Mes tâches"))
      .when(count != null, el => el.child(div().text_size(11).text_color(t.dim).child(count)))
      .child(div().flex_1())
      .when(this.filtered(), el => el.child(div().id("reset-filters").flex_none().text_size(11).text_color(t.accent)
        .cursor_pointer().hover(s => s.underline())
        .tooltip("Réafficher tous les statuts et types, et revenir à l'ordre automatique des statuts")
        .on_click((_e, cx) => { this.resetFilters(); cx.notify(); })
        .child("Reset filters")))
      .child(div().id("refresh").size(24).flex().items_center().justify_center().rounded(6).text_color(t.dim)
        .hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip("Rafraîchir")
        .on_click((_e, cx) => this.refresh(cx))
        .child(this.loading
          ? svg("mods/workspace-chrome/spinner.svg").size(13).text_color(t.working).spin(900)
          : div().text_size(14).child("↻")));
  }

  // A tint per common issue type (names vary by project and language); others stay neutral.
  typeColor(t, type) {
    const n = type.toLowerCase();
    if (/bug|anomalie|défaut/.test(n)) return t.blocked;
    if (/epic|épopée/.test(n)) return t.ansi5;
    if (/story|récit/.test(n)) return t.done;
    if (/sub-?task|sous-tâche/.test(n)) return t.ansi6;
    if (/task|tâche/.test(n)) return t.accent;
    return t.muted;
  }

  typeTag(t, type) {
    const c = this.typeColor(t, type);
    return div().flex_none().px(5).h(15).flex().items_center().rounded(4).text_size(10)
      .border(1).border_color(c).text_color(c).child(type);
  }

  // The agent a new tab starts by default: the installed one Herdr lists first (most picked).
  defaultAgent() {
    return this.installed[0] ?? FALLBACK_AGENT;
  }

  // Where a plain click sends the prompt: the only agent on screen, a new tab of the default
  // agent when there's none, or null when several are on screen (then the picker asks).
  autoTarget(newTab) {
    const shown = newTab ? [] : visibleAgents();
    if (shown.length > 1) return null;
    return shown.length === 1 ? { terminal: shown[0].address, program: shown[0].program } : { agent: this.defaultAgent() };
  }

  // Writes an action's prompt (not sent) into an agent session. `target` is { terminal } or
  // { agent }; left out, autoTarget decides, or the picker opens under the row.
  launch(cx, issue, action, target, newTab = false) {
    target ??= this.autoTarget(newTab);
    if (!target) {
      this.picking = { key: issue.key, action };
      return;
    }
    this.picking = null;
    this.sending = issue.key;
    cx.spawn(async cx => {
      await writePrompt(cx, issue, action, target);
      if (this.sending === issue.key) this.sending = null;
      cx.notify();
    });
  }

  // A program's icon (Herdr's program table): a tinted glyph or a picture.
  programIcon(t, p, size) {
    if (!p?.icon) return null;
    return p.tint ? svg(p.icon).size(size).flex_none().text_color(t.muted) : image(p.icon).size(size).flex_none();
  }

  // Copies the issue key; the icon turns into a check for a moment.
  copyButton(t, issue) {
    const done = this.copied === issue.key;
    return div().id(`copy-${issue.key}`).size(16).flex_none().flex().items_center().justify_center().rounded(4)
      .text_color(done ? t.done : t.dim).hover(s => s.bg(t.raised).text_color(t.foreground))
      .tooltip(`Copier ${issue.key}`)
      .on_click((_e, cx) => {
        cx.stop_propagation();
        cx.write_to_clipboard(issue.key);
        this.copied = issue.key;
        cx.notify();
        cx.timer.after(1500, cx => { if (this.copied === issue.key) { this.copied = null; cx.notify(); } });
      })
      .child(svg(`mods/leddt-jira/${done ? "check" : "copy"}.svg`).size(11));
  }

  // The button shows the icon of the agent a click reaches (none when several are on screen:
  // the picker asks). The tooltip names it, and the agent Shift+click starts.
  agentButton(t, issue, action, target) {
    const program = target?.program ?? target?.agent;
    const where = !target ? "choisir parmi les agents à l'écran"
      : target.terminal ? `dans ${program?.name ?? "l'agent"} à l'écran`
      : `dans un nouvel onglet ${program.name}`;
    return h_flex().id(`agent-${action.id}-${issue.key}`).h(18).px(6).gap(4).flex_none().items_center().rounded(5)
      .text_size(10.5).text_color(t.muted).border(1).border_color(t.border).bg(t.surface)
      .hover(s => s.bg(t.raised).text_color(t.foreground))
      .tooltip(`${action.label} : ${where}\nShift+clic : nouvel onglet ${this.defaultAgent().name}`)
      // Shift+click always starts a new tab of the default agent, whatever is on screen.
      .on_click((e, cx) => {
        cx.stop_propagation();
        this.launch(cx, issue, action, undefined, !!e.modifiers?.shift);
        cx.notify();
      })
      .when(!!program?.icon, el => el.child(this.programIcon(t, program, 10)))
      .child(action.label);
  }

  // Under the row: one line per agent session on screen, one per installed agent for a
  // new tab, and cancel.
  picker(t, issue) {
    const { action } = this.picking;
    const option = (id, icon, label, detail, dot, act) =>
      h_flex().id(id).h(24).px(8).gap(7).items_center().rounded(5).text_size(11.5).cursor_pointer()
        .hover(s => s.bg(t.hover)).on_click((_e, cx) => { act(cx); cx.notify(); })
        .when(!!dot, el => el.child(div().size(6).rounded(3).flex_none().bg(dot)))
        .when(!!icon, el => el.child(icon))
        .child(div().flex_none().text_color(t.foreground).child(label))
        .when(!!detail, el => el.child(div().text_color(t.dim).truncate().child(detail)));
    const installed = this.installed.length ? this.installed : [FALLBACK_AGENT];
    return v_flex().ml(34).mr(12).mb(4).p(4).gap(1).rounded(7).border(1).border_color(t.border).bg(t.popover)
      .child(div().px(8).py(3).text_size(10.5).text_color(t.dim).child(`${action.label} : écrire le prompt dans…`))
      // All in the shown tab: the session name tells them apart, the folder helps.
      .children(visibleAgents().map(a => {
        const cwd = panes().find(p => p.terminal === a.address)?.cwd ?? "";
        const folder = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
        return option(`pick-${a.address}`, this.programIcon(t, a.program, 12), a.title || a.address, folder,
          t[a.status] ?? t.idle, cx => this.launch(cx, issue, action, { terminal: a.address }));
      }))
      .children(installed.map(agent => option(`pick-new-${agent.key}`, this.programIcon(t, agent, 12),
        `Nouvel onglet ${agent.name}`, null, null, cx => this.launch(cx, issue, action, { agent }))))
      .child(option("pick-cancel", null, "Annuler", null, null, () => { this.picking = null; }));
  }

  // The status is the sub-group's header, so the row shows type and key only.
  // On hover, the agent buttons show at the right of the second line.
  row(t, i) {
    const active = this.hoverKey === i.key || this.picking?.key === i.key;
    const target = active ? this.autoTarget(false) : null;
    return v_flex()
      .child(v_flex().id(`issue-${i.key}`).pl(34).pr(12).py(5).gap(2).hover(s => s.bg(t.hover)).cursor_pointer()
        .on_hover((hovered, cx) => {
          if (hovered) this.hoverKey = i.key;
          else if (this.hoverKey === i.key) this.hoverKey = null;
          cx.notify();
        })
        .on_click((_e, cx) => { if (i.url) cx.open_url(i.url); })
        .child(div().text_size(12.5).text_color(t.foreground).truncate().child(i.summary))
        .child(h_flex().h(18).gap(6).items_center().text_size(11)
          .when(!!i.type, el => el.child(this.typeTag(t, i.type)))
          .child(div().text_color(t.dim).flex_none().child(i.key))
          .when(active || this.copied === i.key, el => el.child(this.copyButton(t, i)))
          .child(div().flex_1())
          .when(this.sending === i.key, el => el.child(
            svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.working).spin(900)))
          .when(active && this.sending !== i.key, el => el.children(ACTIONS.map(a => this.agentButton(t, i, a, target))))))
      .when(this.picking?.key === i.key, el => el.child(this.picker(t, i)));
  }

  // Folds are keyed "<project>/<status>", next to the projects' own keys.
  statusGroup(t, project, s) {
    const key = `${project}/${s.name}`, closed = this.collapsed.has(key);
    return v_flex()
      .child(h_flex().id(`status-group-${key}`).h(24).pl(20).pr(16).gap(6).items_center().hover(st => st.bg(t.hover))
        .on_click((_e, cx) => { this.toggle(key); cx.notify(); })
        .child(svg(`mods/leddt-files/${closed ? "chevron-right" : "chevron-down"}.svg`).size(10).flex_none().text_color(t.dim))
        .child(div().size(6).rounded(3).flex_none().bg(this.dot(t, s.category)))
        .child(div().text_size(11).text_color(t.muted).truncate().child(s.name))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).flex_none().child(String(s.issues.length))))
      .when(!closed, el => el.children(s.issues.map(i => this.row(t, i))));
  }

  group(t, g) {
    const closed = this.collapsed.has(g.key);
    return v_flex()
      .child(h_flex().id(`project-${g.key}`).h(28).pl(8).pr(16).gap(5).items_center().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => { this.toggle(g.key); cx.notify(); })
        .child(svg(`mods/leddt-files/${closed ? "chevron-right" : "chevron-down"}.svg`).size(12).flex_none().text_color(t.dim))
        .child(div().text_size(11.5).font_semibold().text_color(t.muted).truncate().child(g.name))
        .child(div().text_size(11).text_color(t.dim).flex_none().child(g.key))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).flex_none().child(String(g.issues.length))))
      .when(!closed, el => el.children(g.statuses.map(s => this.statusGroup(t, g.key, s))));
  }

  render() {
    const t = theme();
    const visible = this.issues?.filter(i => this.passes(i));
    const empty = msg => div().p(14).text_size(12).text_color(t.dim).child(msg);
    const body = this.issues == null
      ? empty(this.error ? "" : "Chargement…")
      : this.issues.length === 0
        ? empty("Aucune tâche ouverte.")
        : visible.length === 0
          ? empty("Aucune tâche avec les filtres choisis.")
          : v_flex().pb(8).children(groups(visible, this.statusOrder).map(g => this.group(t, g)));
    const bars = Object.keys(FILTERS).map(kind => this.filterBar(t, kind)).filter(Boolean);
    // A status drag released off the chips, or leaving the panel, is cancelled.
    const cancelDrag = cx => { if (this.drag) { this.drag = this.dragOver = this.ghost = null; cx.notify(); } };
    const g = this.ghost;
    return v_flex().id("root").relative().size_full().bg(t.surface)
      .on_mouse_up("left", (_e, cx) => cancelDrag(cx))
      .on_hover((hovered, cx) => { if (!hovered) cancelDrag(cx); })
      // While dragging (only then: each move redraws), the ghost follows the pointer.
      // It shows once the pointer has moved a few px, so a click doesn't flash it.
      .on_mouse_move((e, cx) => {
        if (!this.ghost) return;
        const p = e.local_position;
        this.ghost.start ??= p;
        if (!this.ghost.at && Math.hypot(p.x - this.ghost.start.x, p.y - this.ghost.start.y) < 4) return;
        this.ghost.at = p;
        cx.notify();
      })
      .child(this.header(t))
      .children(bars)
      .when(!!this.error, el => el.child(div().px(12).py(6).text_size(11).text_color(t.blocked).child(this.error)))
      .child(div().id("list").flex_1().min_h(0).overflow_y_scrollbar().child(body))
      // No id or handlers: it takes no hit-testing, so the chip under the pointer still gets
      // the hover and the release.
      .when(!!g?.at, el => el.child(
        h_flex().absolute().left(g.at.x - g.grab.x).top(g.at.y - g.grab.y)
          .h(22).px(8).gap(5).items_center().rounded(11).text_size(11)
          .border(1).border_color(t.accent).bg(t.popover).text_color(g.on ? t.foreground : t.dim)
          .shadow_md().opacity(0.92)
          .child(div().size(6).rounded(3).flex_none().bg(g.dot))
          .child(g.label)));
  }
}
