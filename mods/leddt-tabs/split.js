// "New Split Tab": a new unnamed tab with an agent on the left and a shell split to
// its right, both in the space's current folder.
import { run, spaces, panes, focused, notify } from "herdr";

// Where the space is now: the focused pane's live folder when focus is in this
// space (for a mod pane, which has none, its tab's first terminal's), else the
// space's first terminal's, else the folder the space was made in.
function spaceFolder(space) {
  const f = focused(), ps = panes();
  if (f?.space === space.id) {
    const pane = f.pane ? ps.find(p => p.pane === f.pane) : null;
    if (pane?.mod) {
      const mate = ps.find(p => p.tab === pane.tab && p.terminal && p.cwd);
      if (mate) return mate.cwd;
    } else if (f.cwd) return f.cwd;
  }
  const tabIds = new Set(space.tabs.map(t => t.id));
  const first = ps.find(p => tabIds.has(p.tab) && p.terminal && p.cwd);
  return first?.cwd || space.folder || undefined;
}

export async function newSplitTab(cx, spaceId, agent) {
  const space = spaces().find(s => s.id === spaceId);
  if (!space) return;
  const folder = spaceFolder(space);
  const before = new Set(space.tabs.map(t => t.id));
  run("tab.new", { space: space.id, argv: agent.run, folder });
  for (let i = 0; i < 60; i++) {
    const tab = spaces().find(s => s.id === space.id)?.tabs.find(t => !before.has(t.id));
    const pane = tab && panes().find(p => p.tab === tab.id);
    if (pane) {
      // pane.split takes no folder: focus the agent pane, then open the shell to its right.
      run("pane.focus", { pane: pane.pane });
      run("terminal.open", { place: "right", folder });
      return;
    }
    await cx.sleep(50);
  }
  notify({ title: `Couldn't split the new ${agent.name} tab`, body: "The new tab didn't appear in time.", level: "warning" });
}
