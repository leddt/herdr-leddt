// The Review button: reopen this agent's review if it has one (focus its
// Findings pane, or open the pane again), else pick a base and start one
// (leddt-review's picker). Shift+click always starts a new review.
// Sessions are leddt-review's: <Herdr home>/data/leddt-review-sessions/<id>/state.json.
import * as fs from "fs/promises";
import { appHome, readTextFile, panes, run, shared, setShared, openOverlay } from "herdr";

const PANES = "leddt-review.panes";

// The newest session started from this terminal on this branch.
async function latestSession(origin, branch) {
  const dir = `${appHome()}/data/leddt-review-sessions`;
  let ids = [];
  try { ids = await fs.readdir(dir); } catch { return null; }
  // Ids are base-36 timestamps: newest first.
  ids.sort((a, b) => parseInt(b, 36) - parseInt(a, 36));
  for (const id of ids.slice(0, 50)) {
    const text = await readTextFile(`${dir}/${id}/state.json`).catch(() => null);
    try {
      const s = text && JSON.parse(text);
      if (s?.origin === origin && (!branch || !s.branch || s.branch === branch)) return s;
    } catch {}
  }
  return null;
}

export async function review(cx, p, fresh) {
  const s = fresh ? null : await latestSession(p.terminal, p.branch);
  if (!s) {
    openOverlay({ mod: "leddt-review", kind: "popup", width: 400, height: 380,
      props: { mode: "pick", origin: p.terminal, pane: p.pane, cwd: p.cwd } });
    return;
  }
  const known = (shared(PANES) ?? {})[s.id];
  // Sessions from before panes were remembered: the review pane in this tab, if there is one.
  const open = panes().find((x) => x.pane === known) ??
    (known ? null : panes().find((x) => x.mod === "leddt-review" && x.tab === p.tab));
  if (open) {
    if (open.pane !== known) setShared(PANES, { ...(shared(PANES) ?? {}), [s.id]: open.pane });
    run("pane.focus", { pane: open.pane });
    return;
  }
  const before = new Set(panes().map((x) => x.pane));
  run("pane.split", { direction: "right", pane: p.pane, mod: "leddt-review", props: { session: s.id } });
  for (let i = 0; i < 60; i++) {
    const mine = panes().find((x) => x.mod === "leddt-review" && !before.has(x.pane));
    if (mine) {
      setShared(PANES, { ...(shared(PANES) ?? {}), [s.id]: mine.pane });
      run("pane.focus", { pane: mine.pane });
      return;
    }
    await cx.sleep(50);
  }
}
