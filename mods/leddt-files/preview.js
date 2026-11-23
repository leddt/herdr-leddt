// Previews: a leddt-markdown or leddt-image pane in the shown tab. A click reuses the
// latest one (focused as is when it already shows the file); Ctrl+click splits a new one
// beside the focused pane, Shift+click opens one in a new tab named after the file.
// <mod>.panes ({ [pane]: { file, on, id, at } }) finds them again: id (also in its props)
// addresses it, at is when it was last given a file. A pane of the same mod is sent the
// file (leddt-preview.show { [id]: { file, on, at } }); one of the other mod, or from before
// ids, is replaced by a new pane where it is. Each pane is named after its file
// (pane.rename) and keeps Files on this folder (leddt.pane-folders).
// Used by Files' eye button (main.js) and by Ctrl-clicks on terminal links (link.js).
import { panes, focused, shared, setShared, run } from "herdr";

export const isMarkdown = (name) => /\.(md|markdown|mdx)$/i.test(name);
export const isImage = (name) => /\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?|avif)$/i.test(name);
// The mod that previews a file, or null. Images are read from disk by path: local only.
export const previewer = (name, on) => isMarkdown(name) ? "leddt-markdown" : isImage(name) && !on ? "leddt-image" : null;
const PREVIEW_MODS = ["leddt-markdown", "leddt-image"];
const SHOW = "leddt-preview.show";

// mode: "reuse" (a click), "pane" (Ctrl), "tab" (Shift). wait(ms) resolves after ms (null:
// a new pane isn't looked for, so it isn't noted). where: { space, tab, pane } to open beside,
// the focused pane by default. Resolves once the preview is open, or false when there's none.
export async function preview(file, on, folder, mode, wait, where = focused()) {
  const mod = previewer(file, on);
  const all = panes(), name = file.split(/[\\/]/).pop();
  if (!mod || !where?.tab) return false;
  on = on ?? null;
  const tab = all.filter(p => p.tab === where.tab), entry = (p) => shared(`${p.mod}.panes`)?.[p.pane];
  // Untracked ones (opened before ids) count as the oldest, and are replaced.
  const previews = tab.filter(p => PREVIEW_MODS.includes(p.mod)).sort((a, b) => (entry(b)?.at ?? 0) - (entry(a)?.at ?? 0));
  const id = Math.random().toString(36).slice(2), at = Date.now(), value = { file, on, id, at };
  if (mode === "reuse") {
    const same = previews.find(p => p.mod === mod && entry(p)?.file === file && (entry(p)?.on ?? null) === on);
    if (same) { remember(same.pane, mod, { ...entry(same), at }, name, folder); run("pane.focus", { pane: same.pane }); return true; }
    const last = previews[0];
    if (last?.mod === mod && entry(last)?.id) {
      // Requests a minute old are done with.
      const pending = Object.fromEntries(Object.entries(shared(SHOW) ?? {}).filter(([, r]) => at - (r?.at ?? 0) < 60000));
      setShared(SHOW, { ...pending, [entry(last).id]: { file, on, at } });
      remember(last.pane, mod, { ...value, id: entry(last).id }, name, folder);
      run("pane.focus", { pane: last.pane });
      return true;
    }
    if (last) {
      // The other kind, or untracked: a new pane where it is, and then it goes.
      run("pane.split", { direction: "right", pane: last.pane, mod, props: { file, on, id } });
      await adopt(wait, all, mod, where.tab, value, name, folder, last.pane);
      return true;
    }
  }
  if (mode === "tab") run("tab.new", { name, space: where.space, mod, props: { file, on, id } });
  else {
    const beside = tab.find(p => p.pane === where.pane) ?? tab[0];
    if (!beside) return false;
    run("pane.split", { direction: "right", pane: beside.pane, mod, props: { file, on, id } });
  }
  await adopt(wait, all, mod, mode === "tab" ? null : where.tab, value, name, folder, null);
  return true;
}

// A pane opened by a command shows up in panes() a little later: looks for it (a pane of
// mod, in tab when given, that wasn't in before) for up to 5s, then notes it and closes replaced.
async function adopt(wait, before, mod, tab, value, name, folder, replaced) {
  for (let tries = 0; ; tries++) {
    const added = panes().find(p => p.mod === mod && (!tab || p.tab === tab) && !before.some(q => q.pane === p.pane));
    if (added) {
      if (replaced) run("pane.close", { pane: replaced });
      return remember(added.pane, mod, value, name, folder);
    }
    if (!wait || tries >= 100) break;
    await wait(50);
  }
  // Not found (or no way to wait): the replaced pane still goes, beside its replacement.
  if (replaced) run("pane.close", { pane: replaced });
}

// Notes what a preview pane shows, and names it after its file. Entries of closed panes go as new ones come.
function remember(pane, mod, value, name, folder) {
  const live = new Set(panes().map(p => p.pane));
  const keep = (map) => Object.fromEntries(Object.entries(map ?? {}).filter(([p]) => live.has(p)));
  for (const m of PREVIEW_MODS) if (m !== mod) setShared(`${m}.panes`, keep(shared(`${m}.panes`)));
  setShared(`${mod}.panes`, { ...keep(shared(`${mod}.panes`)), [pane]: value });
  setShared("leddt.pane-folders", { ...keep(shared("leddt.pane-folders")), [pane]: folder });
  if (panes().find(p => p.pane === pane)?.name !== name) run("pane.rename", { pane, name });
}
