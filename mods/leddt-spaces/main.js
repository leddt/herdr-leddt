// Workspace spaces: the project's icon or a stable colored avatar, worktrees under their checkout,
// grouped by machine when more than one is known. Two lines per space: its name
// (and its branch's open pull request, GitHub or Azure DevOps, on the right), then
// the branch its first terminal is on now (else the repo, else the folder) with
// ahead/behind. Agent state lives in the agents list, not here. Click to
// switch, right-click for its menu, drag to reorder.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle, InputState, Input } from "gpui-base";
import { spaces, machines, panes, run, openOverlay, exec, hc, theme, shared, setShared, watchFolder, window, layout, home, appHome, nextCommand, props, closeOverlay } from "herdr";
import * as fs from "fs/promises";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 40 : 42);
const RAIL_CELL = 32;
const railCell = (el) => h_flex().flex_none().justify_center().child(el);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// A repo's name from its git folder: the folder holding .git, a bare repo's own
// name, or the folder holding a hidden bare repo (<project>/.bare).
const repoName = (common) => {
  if (common.endsWith("/.git")) return base(common.slice(0, -5));
  const own = base(common);
  return own === ".bare" ? base(common.slice(0, -own.length - 1)) : own.replace(/\.git$/, "");
};
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;
// Places looked at together (two git runs each). All at once, a few hundred spaces
// run out of the app's open files (256 when started from the Dock on macOS) or
// past a machine core's 16 running execs, and those spaces wait for FALLBACK.
const AT_ONCE = 6;

// Both runs, finished: a place isn't done while one of its runs still holds a slot.
async function both(a, b) {
  const done = await Promise.allSettled([a, b]);
  const failed = done.find((d) => d.status === "rejected");
  if (failed) throw failed.reason;
  return done.map((d) => d.value);
}

// A pull request is looked for when its place's git is (see `due`), at most this often.
const PR_MIN = 30000;
const prKey = (g) => JSON.stringify([g.repo, g.branch]);

// "~/code/x" for a folder under home, else the folder as is.
function shortPath(path) {
  const p = (path ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  const h = (home() ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  return h && (p === h || p.toLowerCase().startsWith(h.toLowerCase() + "/")) ? "~" + p.slice(h.length) : p;
}

function openUrl(url) {
  const p = window()?.platform;
  if (p === "windows") return exec("explorer.exe", [url]);
  return exec(p === "macos" ? "open" : "xdg-open", [url]);
}

// Where a repo's pull requests live, from its origin's URL: GitHub, Azure DevOps, or neither.
const azure = (org, project, repo) => ({ kind: "azure", org: `https://dev.azure.com/${org}`, project: decodeURIComponent(project), repo: decodeURIComponent(repo.replace(/\.git$/, "")) });
export function forge(url) {
  const u = (url ?? "").trim().replace(/\/+$/, "");
  if (/github\.com[:/]/i.test(u)) return { kind: "github" };
  let m = /(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com):v3\/([^/]+)\/([^/]+)\/([^/]+)$/i.exec(u);
  if (m) return azure(m[1], m[2], m[3]);
  m = /dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/i.exec(u);
  if (m) return azure(m[1], m[2], m[3]);
  m = /\/\/(?:[^@/]+@)?([^./@]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+)/i.exec(u);
  if (m) return azure(m[1], m[2], m[3]);
  return null;
}

// `az` is a .cmd on Windows, which isn't found by its bare name.
async function az(args, opts) {
  try { return await exec("az", args, opts); } catch { return exec("az.cmd", args, opts); }
}

// The branch's open pull request: { number, url, draft }, or null.
async function findPr(f, branch, cwd, on) {
  if (f.kind === "github") {
    const r = await exec("gh", ["pr", "list", "--head", branch, "--state", "open", "--json", "number,url,isDraft", "--limit", "1"], { cwd, on });
    if (r.code !== 0) throw new Error(r.stderr);
    const pr = JSON.parse(r.stdout || "[]")[0];
    return pr ? { number: pr.number, url: pr.url, draft: pr.isDraft } : null;
  }
  const r = await az(["repos", "pr", "list", "--organization", f.org, "--project", f.project, "--repository", f.repo,
    "--source-branch", `refs/heads/${branch}`, "--status", "active", "--top", "1", "-o", "json"], { cwd, on, timeout: 60000 });
  if (r.code !== 0) throw new Error(r.stderr);
  const pr = JSON.parse(r.stdout || "[]")[0];
  if (!pr) return null;
  const url = `${f.org}/${encodeURIComponent(f.project)}/_git/${encodeURIComponent(f.repo)}/pullrequest/${pr.pullRequestId}`;
  return { number: pr.pullRequestId, url, draft: !!pr.isDraft };
}

// Avatars can be the project's icon. Each space's choice, set from its menu (leddt-menu):
// { [space]: "letter" | { file } }; none: the icon found in its repo, else the letter.
const ICONS = "leddt-spaces.icons";
// What each space's avatar shows now, for other mods (see publishAvatars).
const AVATARS = "leddt-spaces.avatars";
// image() only reads under the Herdr home, so icons are copied there (by a hash of where they came from).
const ICON_DIR = "data/leddt-spaces-icons";
const IMAGE = /\.(svg|png|ico|jpe?g|webp|gif|bmp)$/i;
// Folders whose icons are someone else's (packages, tools, tests, build output).
const NOT_MINE = /^(node_modules|vendor|third_party|3rdparty|bower_components|packages|app_plugins|umbraco|umbraco_client|tests?|__tests__|spec|fixtures|mocks?|examples?|samples?|bin|obj|dist|build|out|target)$/i;
const iconKey = (on, path) => JSON.stringify([on ?? null, path]);

function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

// How sure a tracked file is the project's icon, by its name; 0: not an icon of the project.
export function iconScore(path, repo) {
  const parts = path.split("/");
  if (parts.slice(0, -1).some((p) => p.startsWith(".") || NOT_MINE.test(p))) return 0;
  const file = parts[parts.length - 1].toLowerCase();
  const ext = file.slice(file.lastIndexOf(".") + 1);
  const name = file.slice(0, file.lastIndexOf("."));
  const r = (repo ?? "").toLowerCase();
  let s = 0, m;
  if (name === "favicon") s = 100;
  else if (/^apple-touch-icon(-precomposed)?$/.test(name)) s = 96;
  else if ((m = /^(?:android-chrome|icon|favicon)[-_](\d+)(?:x\d+)?$/.exec(name))) s = 84 + Math.min(+m[1], 256) / 32;
  else if (/^apple-touch-icon-\d+x\d+$/.test(name)) s = 88;
  else if (/^(app[-_]?icon|icon)$/.test(name)) s = 82;
  else if (/^logo(192|512)?$/.test(name)) s = 75;
  else if (r && (name === `logo-${r}` || name === `logo_${r}` || name === `logo__${r}` || name === `${r}-logo` || name === r)) s = 74;
  if (!s) return 0;
  s += { svg: 6, png: 4, webp: 3, jpg: 2, jpeg: 2, gif: 1, bmp: 1 }[ext] ?? 0;
  return s - 2 * (parts.length - 1);
}

// The project's icon in a repo: the best-named tracked image, or null when none is conclusive.
async function findIcon(top, repo, on) {
  const r = await exec("git", ["ls-files", "-z", "--", ":(icase)*favicon*", ":(icase)*icon*", ":(icase)*logo*", ...(repo ? [`:(icase)*${repo}.*`] : [])], { cwd: top, on });
  if (r.code !== 0) return null;
  let best = null, score = 0;
  for (const f of r.stdout.split("\0")) {
    if (!IMAGE.test(f)) continue;
    const s = iconScore(f, repo);
    if (s > score) [best, score] = [f, s];
  }
  return best && `${top}/${best}`;
}

// Raster icons are shrunk to this many pixels a side (twice the avatar's 18) with a good
// filter: the renderer scales an image in one step, which leaves a big one jagged.
const ICON_PX = 36;

// Shrinks a raster image to ICON_PX, centered on a clear square; true when it could.
async function shrinkIcon(src, dst) {
  const p = window()?.platform;
  if (p === "windows") {
    const q = (s) => `'${s.replace(/\//g, "\\").replace(/'/g, "''")}'`;
    const script = "Add-Type -AssemblyName System.Drawing;"
      + `$src = ${q(src)}; $n = ${ICON_PX};`
      + "$img = if ($src -match '\\.ico$') { (New-Object System.Drawing.Icon($src, 256, 256)).ToBitmap() } else { [System.Drawing.Image]::FromFile($src) };"
      + "if ($img.Width -le $n -and $img.Height -le $n) { exit 2 };"
      + "$k = [Math]::Min($n / $img.Width, $n / $img.Height);"
      + "$w = [int][Math]::Max(1, [Math]::Round($img.Width * $k)); $h = [int][Math]::Max(1, [Math]::Round($img.Height * $k));"
      + "$bmp = New-Object System.Drawing.Bitmap($n, $n, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb);"
      + "$g = [System.Drawing.Graphics]::FromImage($bmp);"
      + "$g.InterpolationMode = 'HighQualityBicubic'; $g.SmoothingMode = 'HighQuality'; $g.PixelOffsetMode = 'HighQuality'; $g.CompositingQuality = 'HighQuality';"
      + "$a = New-Object System.Drawing.Imaging.ImageAttributes; $a.SetWrapMode('TileFlipXY');"
      + "$r = New-Object System.Drawing.Rectangle([int](($n - $w) / 2), [int](($n - $h) / 2), $w, $h);"
      + "$g.DrawImage($img, $r, 0, 0, $img.Width, $img.Height, 'Pixel', $a);"
      + `$bmp.Save(${q(dst)}, [System.Drawing.Imaging.ImageFormat]::Png)`;
    const r = await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 30000 });
    return r.code === 0;
  }
  if (p === "macos") {
    const r = await exec("sips", ["-s", "format", "png", "-Z", String(ICON_PX), src, "--out", dst]);
    return r.code === 0;
  }
  try {
    const r = await exec("magick", [src + "[0]", "-resize", `${ICON_PX}x${ICON_PX}>`, "-background", "none", "-gravity", "center", "-extent", `${ICON_PX}x${ICON_PX}`, `png:${dst}`]);
    return r.code === 0;
  } catch {
    return false;
  }
}

// Copies an icon (on this computer) under the Herdr home; answers its path for image(), or null.
async function copyIcon(src) {
  const ext = (/\.([a-z0-9]+)$/i.exec(src)?.[1] ?? "png").toLowerCase();
  await fs.mkdir(`${appHome()}/${ICON_DIR}`, { recursive: true });
  if (ext !== "svg") {
    const rel = `${ICON_DIR}/${hash(src)}-${ICON_PX}.png`;
    if (await shrinkIcon(src, `${appHome()}/${rel}`).catch(() => false)) return rel;
  }
  // Small enough already, a vector, or no way to shrink it here: as is.
  const rel = `${ICON_DIR}/${hash(src)}.${ext}`;
  const dst = `${appHome()}/${rel}`;
  // fs reads only under the home folder; a project can be anywhere.
  const win = (s) => s.replace(/\//g, "\\");
  const r = window()?.platform === "windows"
    ? await exec("cmd", ["/d", "/c", "copy", "/y", win(src), win(dst)])
    : await exec("cp", [src, dst]);
  return r.code === 0 ? rel : null;
}

// The system's file picker (this computer): the chosen file, or null.
async function pickFile(start) {
  const p = window()?.platform;
  const q = (s) => (s ?? "").replace(/'/g, "''");
  let r;
  if (p === "windows") {
    const script = "Add-Type -AssemblyName System.Windows.Forms;"
      + "$o = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false };"
      + "$d = New-Object System.Windows.Forms.OpenFileDialog;"
      + "$d.Title = 'Choose an icon';"
      + "$d.Filter = 'Images|*.svg;*.png;*.ico;*.jpg;*.jpeg;*.webp;*.gif;*.bmp|All files|*.*';"
      + `$d.InitialDirectory = '${q((start ?? "").replace(/\//g, "\\"))}';`
      + "if ($d.ShowDialog($o) -eq 'OK') { [Console]::Out.Write($d.FileName) }";
    r = await exec("powershell", ["-NoProfile", "-STA", "-Command", script], { timeout: 600000 });
  } else if (p === "macos") {
    const at = start ? ` default location (POSIX file "${start.replace(/["\\]/g, "\\$&")}")` : "";
    r = await exec("osascript", ["-e", `POSIX path of (choose file with prompt "Choose an icon"${at})`], { timeout: 600000 });
  } else {
    try {
      r = await exec("zenity", ["--file-selection", "--title=Choose an icon", ...(start ? [`--filename=${start}/`] : []),
        "--file-filter=Images | *.svg *.png *.ico *.jpg *.jpeg *.webp *.gif *.bmp", "--file-filter=All files | *"], { timeout: 600000 });
    } catch {
      r = await exec("kdialog", ["--getopenfilename", start || home()], { timeout: 600000 });
    }
  }
  const file = r.code === 0 ? r.stdout.trim() : "";
  return file ? file.replace(/\\/g, "/") : null;
}

// Keep the whole leading emoji in the avatar (the shipped spaces and picker do the same;
// leddt-agents shows the one published in leddt-spaces.avatars).
// Newer pictographs such as 🖥 may be drawn as emoji without VS16. A trailing
// selector, modifier or joiner can signal that we matched only part of a glyph.
const EMOJI = /^(?:[#*0-9]\uFE0F?\u20E3|\p{Regional_Indicator}{2}|(?:\p{Emoji_Presentation}|(?=[\u{1F000}-\u{1FFFF}])\p{Extended_Pictographic}|\p{Extended_Pictographic}(?=\uFE0F)|\p{Emoji_Modifier_Base}(?=\p{Emoji_Modifier}))\uFE0F?[\p{Emoji_Modifier}\u{E0020}-\u{E007F}]*(?:\u200D\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?)*)(?![\p{Grapheme_Extend}\p{Emoji_Modifier}\u200D])/u;
function spaceAvatar(name) {
  return EMOJI.exec(name)?.[0] ?? ([...name][0]?.toUpperCase() ?? "?");
}

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// Groups of spaces, made from a space's menu (Group…) or the folder button in the
// header: { list: [{ id, name }], of: { [space]: group } }. A worktree under its
// checkout follows the checkout's group. Folded groups are this screen's (localStorage).
const GROUPS = "leddt-spaces.groups";
function groupsOf() {
  const g = shared(GROUPS);
  const list = Array.isArray(g?.list) ? g.list.filter((x) => x && typeof x.id === "string") : [];
  const of = g?.of && typeof g.of === "object" && !Array.isArray(g.of) ? g.of : {};
  return { list, of };
}
// Puts a space in a group (null: in none).
function setGroup(space, group) {
  const g = groupsOf();
  const of = { ...g.of };
  if (group) of[space] = group;
  else delete of[space];
  setShared(GROUPS, { list: g.list, of });
}

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

export default class Spaces extends View {
  init(_props, cx) {
    // The group popups and the name dialog are this mod too, opened as overlays.
    const p = props();
    if (p?.groupName) return this.initGroupName(cx);
    if (p?.groupMenu || p?.groupHead) return;
    try { this.groupFolded = new Set(JSON.parse(localStorage.getItem("groups.folded") ?? "[]")); } catch { this.groupFolded = new Set(); }
    this.localSeen = new Set(); // this computer's spaces seen since start: a group forgets one only once it's gone
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Map(); // local repos' pending folder watches
    this.prs = {}; // prKey() -> { number, url, draft }, null: none open
    this.prAt = {}; // prKey() -> when it was last looked for
    this.prPending = new Map(); // prKey() -> where to ask
    this.forges = {}; // repo -> forge() of its origin, null: neither
    this.found = {}; // iconKey(on, top) -> the repo's icon file, null: none conclusive
    this.icons = {}; // iconKey(on, file) -> its copy for image(), null: couldn't copy; absent: not yet
    this.copying = new Set();
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.scroll = ScrollHandle.new(); // the list's position: the active space is brought into view through it
    this.activeAt = -1; // the active space's place among the list's children (headers and rows), -1 when not drawn
    this.machines = [];
    try {
      this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
      if (!this.reconnecting || typeof this.reconnecting !== "object" || Array.isArray(this.reconnecting)) this.reconnecting = {};
      for (const state of Object.values(this.reconnecting)) state.busy = false;
    } catch { this.reconnecting = {}; }
    try { this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]")); } catch { this.folded = new Set(); }
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // Refresh only when the refs could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
    // The space menu's items (leddt-menu): "icon-<pick|auto|letter>:<space>", "group:<space>".
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        const m = /^icon-(pick|auto|letter):(.+)$/.exec(c);
        if (m) await this.setIcon(m[1], decodeURIComponent(m[2]), cx);
        const g = /^group:(.+)$/.exec(c);
        if (g) openOverlay({ mod: "leddt-spaces", kind: "popup", width: 220, height: 360, props: { groupMenu: { space: decodeURIComponent(g[1]) } } });
      }
    });
  }

  initGroupName(cx) {
    const { groupName: n } = props();
    const current = n.group ? groupsOf().list.find((g) => g.id === n.group)?.name ?? "" : "";
    this.text = current;
    this.input = InputState.new({ value: current, placeholder: "Group name" });
    if (current) this.input.set_selected_range({ start: 0, end: current.length });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.submitGroupName(cx));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
  }

  // Renames the group, or makes a new one (with the space it was asked from in it).
  submitGroupName() {
    const { groupName: n, overlay } = props();
    const name = (this.text ?? "").replace(/\s+/g, " ").trim();
    closeOverlay(overlay);
    if (!name) return;
    const g = groupsOf();
    if (n.group) {
      setShared(GROUPS, { list: g.list.map((x) => (x.id === n.group ? { ...x, name } : x)), of: g.of });
      return;
    }
    const id = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    setShared(GROUPS, { list: [...g.list, { id, name }], of: n.space ? { ...g.of, [n.space]: id } : g.of });
  }

  groupNameDialog(t) {
    const p = props();
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click(action).child(text);
    const renaming = Boolean(p.groupName.group);
    return v_flex().id("group-name").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(p.overlay); cx.stop_propagation(); } })
      .w_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child(renaming ? "Rename group" : "New group"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().pt(16).pb(7).text_size(11.5).text_color(t.dim).child("Name"))
      .child(Input.new(this.input).h(36).px(10).rounded(9).border_1().border_color(t.accent).bg(t.background).text_size(12.8).text_color(t.foreground))
      .child(h_flex().pt(20).gap(8).justify_end()
        .child(button("gn-cancel", "Cancel", false, () => closeOverlay(p.overlay)))
        .child(button("gn-save", renaming ? "Rename" : "Create", true, () => this.submitGroupName())));
  }

  // A small menu of [label, icon, action, checked?] items; null draws a separator.
  popupMenu(t, title, items) {
    const close = () => closeOverlay(props().overlay);
    return v_flex().w_full().p(5).bg(t.popover).text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).truncate().child(title))
      .children(items.map((it, i) => !it
        ? div().mx(7).my(4).h(1).bg(t.border)
        : h_flex().id(`gm-${i}`).h(31).px(8).gap(9).rounded(7).items_center().text_color(t.foreground)
          .hover((s) => s.bg(t.hover))
          .on_click(() => { close(); it[2](); })
          .child(svg(`mods/workspace-chrome/${it[1]}.svg`).size(14).flex_none().text_color(t.muted))
          .child(div().flex_1().min_w(0).truncate().child(it[0]))
          .when(Boolean(it[3]), (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))));
  }

  // A space's Group… menu: its groups, a new one, out of its group.
  groupMenu(t) {
    const { space } = props().groupMenu;
    const { list, of } = groupsOf();
    const now = list.some((g) => g.id === of[space]) ? of[space] : null;
    const name = spaces().find((s) => s.id === space)?.name ?? "Space";
    return this.popupMenu(t, `Group ${name}`, [
      ...list.map((g) => [g.name, "folder", () => setGroup(space, g.id === now ? null : g.id), g.id === now]),
      ...(list.length ? [null] : []),
      ["New group…", "folder-plus", () => openOverlay({ mod: "leddt-spaces", kind: "dialog", width: 380, height: 190, props: { groupName: { space } } })],
      ...(now ? [["Remove from group", "x", () => setGroup(space, null)]] : []),
    ]);
  }

  // A group header's menu: rename, move, delete (its spaces stay, out of any group).
  groupHeadMenu(t) {
    const { group } = props().groupHead;
    const g = groupsOf();
    const at = g.list.findIndex((x) => x.id === group);
    if (at < 0) return v_flex();
    const move = (by) => () => {
      const list = [...g.list];
      list.splice(at + by, 0, list.splice(at, 1)[0]);
      setShared(GROUPS, { list, of: g.of });
    };
    return this.popupMenu(t, g.list[at].name, [
      ["Rename…", "square-pen", () => openOverlay({ mod: "leddt-spaces", kind: "dialog", width: 380, height: 190, props: { groupName: { group } } })],
      ...(at > 0 ? [["Move up", "chevron-left", move(-1)]] : []),
      ...(at < g.list.length - 1 ? [["Move down", "chevron-right", move(1)]] : []),
      null,
      ["Delete group", "x", () => setShared(GROUPS, {
        list: g.list.filter((x) => x.id !== group),
        of: Object.fromEntries(Object.entries(g.of).filter(([, v]) => v !== group)),
      })],
    ]);
  }

  async setIcon(what, id, cx) {
    let choice = what === "letter" ? "letter" : null;
    if (what === "pick") {
      const s = spaces().find((x) => x.id === id);
      const g = s && this.git[where(s, panes())];
      // The picker is this computer's: it starts in the project when the space is here.
      const file = await pickFile(s && !s.machine ? g?.top ?? place(s, panes()) : home()).catch(() => null);
      if (!file) return;
      choice = { file };
      delete this.icons[iconKey(null, file)]; // copied again: it may have changed
    }
    const all = { ...(shared(ICONS) ?? {}) };
    if (choice) all[id] = choice;
    else delete all[id];
    setShared(ICONS, all);
    this.copyIcons(cx);
  }

  // The icon a space shows: { key, on, file } of its source, or null for the letter.
  iconSource(s, g) {
    const choice = (shared(ICONS) ?? {})[s.id];
    if (choice === "letter") return null;
    if (choice?.file) return { key: iconKey(null, choice.file), on: null, file: choice.file };
    const file = g?.top ? this.found[iconKey(s.machine, g.top)] : null;
    return file ? { key: iconKey(s.machine, file), on: s.machine ?? null, file } : null;
  }

  // Copies the icons shown but not copied yet, one at a time.
  copyIcons(cx) {
    const ps = panes();
    for (const s of spaces()) {
      const src = this.iconSource(s, this.git[where(s, ps)]);
      // Another machine's files aren't copied here: its spaces keep their letter.
      if (!src || src.on || src.key in this.icons || this.copying.has(src.key)) continue;
      this.copying.add(src.key);
      cx.spawn(async (cx) => {
        this.icons[src.key] = await copyIcon(src.file).catch(() => null);
        this.copying.delete(src.key);
        cx.notify();
      });
    }
  }

  checkNew(cx) {
    this.copyIcons(cx);
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id)) || this.orderingDue(now)) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    for (const k of Object.keys(this.git)) if (!keys.has(k)) {
      delete this.git[k];
      delete this.checked[k];
      this.unsure.delete(k);
    }
    const repos = new Set(Object.values(this.git).filter(Boolean).map((g) => g.repo));
    for (const [repo, pending] of this.watching) if (!repos.has(JSON.stringify([null, repo]))) {
      this.watching.delete(repo);
      pending.cancel();
    }
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(AT_ONCE, keys.length) }, async () => {
          while (next < keys.length) await this.check(keys[next++], cx);
        }));
      }
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // Ref-only reads avoid scanning the worktree or waking its index watch.
      // Two reads: a folder name may itself contain a newline.
      const [r, common] = await both(
        exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], { cwd, on }),
        exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on }),
      );
      if (r.code !== 0 || common.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.code !== 0 ? r.stderr : common.stderr)) {
          this.unsure.add(key);
          this.git[key] ??= null;
        } else this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = r.stdout.replace(/\n$/, ""), repo = common.stdout.replace(/\n$/, "");
      const [branch, counts] = await both(
        exec("git", ["symbolic-ref", "-q", "HEAD"], { cwd, on }),
        exec("git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { cwd, on }),
      );
      const name = repoName(repo);
      const [ahead, behind] = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [0, 0];
      const info = { name, top, branch: branch.code === 0 ? branch.stdout.trim().replace(/^refs\/heads\//, "") : "(detached)", ahead, behind, repo: JSON.stringify([on, repo]), linked: repo !== `${top}/.git` };
      // The project's icon, once per checkout (here only: see copyIcons).
      const ik = iconKey(on, info.top);
      if (!on && info.top && !(ik in this.found)) this.found[ik] = await findIcon(info.top, name, on).catch(() => null);
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
      // A turn that ended may have opened the PR: look whenever git was looked at.
      const pk = prKey(info);
      if (info.branch && Date.now() - (this.prAt[pk] ?? 0) > PR_MIN) this.refreshPr(pk, { info, cwd, on }, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  // One pull request lookup at a time, apart from git's: `az` takes seconds.
  refreshPr(pk, at, cx) {
    this.prPending.set(pk, at);
    if (this.prBusy) return;
    this.prBusy = true;
    cx.spawn(async (cx) => {
      while (this.prPending.size) {
        const [k, { info, cwd, on }] = this.prPending.entries().next().value;
        this.prPending.delete(k);
        this.prAt[k] = Date.now();
        try {
          if (!(info.repo in this.forges)) {
            const r = await exec("git", ["remote", "get-url", "origin"], { cwd, on });
            this.forges[info.repo] = r.code === 0 ? forge(r.stdout) : null;
          }
          const f = this.forges[info.repo];
          this.prs[k] = f ? await findPr(f, info.branch, cwd, on) : null;
        } catch {
          // Not installed, not signed in, offline: keep what it showed.
          this.prs[k] ??= null;
        }
        cx.notify();
      }
      this.prBusy = false;
    });
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    const pending = watchFolder(repo);
    this.watching.set(repo, pending);
    cx.spawn(async (cx) => {
      let current = pending;
      try {
        for (;;) {
          await current;
          if (this.watching.get(repo) !== current) return;
          const mine = JSON.stringify([null, repo]);
          const keys = Object.keys(this.git).filter((k) => this.git[k]?.repo === mine);
          if (!keys.length) break;
          this.refreshGit(keys, cx);
          current = watchFolder(repo);
          this.watching.set(repo, current);
        }
      } catch {}
      if (this.watching.get(repo) === current) this.watching.delete(repo);
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "leddt-menu", kind: "popup", width: 200, height: 380, props: { tab: "space", target: { id: w.id } } });
  }

  orderingDue(now) {
    return this.ordering && now - this.ordering.at >= 1000
      && this.ordering.machines.every(name => machines().some(m => m.name === name && m.layout === "ready"));
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null, cwd: place(w, ps) }));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    let out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    // Within each machine: spaces in no group first, then each group's, in the groups' order.
    // A worktree under its checkout goes with it.
    const { list: groups, of } = groupsOf();
    const rank = new Map(groups.map((g, n) => [g.id, n]));
    const machineAt = new Map();
    let group = null;
    out = out.map((r, n) => {
      if (!r.tree) group = rank.has(of[r.w.id]) ? of[r.w.id] : null;
      const m = r.w.machine ?? null;
      if (!machineAt.has(m)) machineAt.set(m, machineAt.size);
      return { ...r, group, n, m: machineAt.get(m), g_at: group ? rank.get(group) : -1 };
    }).sort((a, b) => a.m - b.m || a.g_at - b.g_at || a.n - b.n);
    // Simulate the batch so later indexes include earlier moves. An attempted
    // write can lose a sync conflict: allow the echo to settle before retrying.
    const order = sp.map(w => w.id);
    const target = out.map(r => r.w.id);
    const key = JSON.stringify([order, target, machines()]);
    if (order.every((id, i) => id === target[i])) {
      this.ordering = null;
    } else if (this.ordering?.key !== key || this.orderingDue(Date.now())) {
      const moved = new Set();
      this.ordering = { key, at: Date.now(), machines: [] };
      for (let i = 0; i < out.length; i++) {
        const from = order.indexOf(out[i].w.id);
        if (from === i) continue;
        run("space.move", { id: out[i].w.id, index: i + 1 });
        moved.add(out[i].w.machine ?? null);
        order.splice(i, 0, order.splice(from, 1)[0]);
      }
      this.ordering.machines = [...moved];
    }
    return out.filter(r => this.shown.has(r.w.id));
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const rows = this.ordered();
    const draw = (r) => (collapsed ? this.compact(r, t) : this.row(r, t));
    // Where the active space's row lands among the children this returns: the list scrolls by its direct
    // children, and machine headers, login notes and loading rows count too.
    this.activeAt = -1;
    let before = 0;
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name), ...Object.keys(this.reconnecting)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => h_flex().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).items_center().when(collapsed, el => el.justify_center()).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) {
      if (loading(null) && !rows.length) return [loadingRow(null)];
      const { items, active } = this.withGroups(rows, rows, null, collapsed, t, draw);
      this.activeAt = active;
      return items;
    }
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const login = machine?.state === "needs_login" ? `hc machine login ${m}` : null;
      const folded = this.folded.has(m);
      const icon = svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none();
      const badge = div().absolute().right(-3).bottom(-2).size(6).rounded(3).border_1().border_color(t.chrome).bg(connected ? t.ansi2 : t.dim);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .when(collapsed, el => el.mt(4).w(RAIL_CELL).justify_center().rounded(6).tooltip(login ? `${m} needs a login: run ${login}. Click for Copy.` : m ? `${m} · ${connected ? "connected" : (machine?.state ?? "asleep").replace(/_/g, " ")}` : "This computer"))
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          if (collapsed && login) { run("app.settings", { section: "machines" }); return; }
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .when(machine?.keeps_running_after_logout === false, el => el.child(div().id(`machine-logout-${m}`)
          .flex_none().text_color(t.blocked).tooltip("Agents stop when you disconnect. Click for the fix.")
          .on_click((_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "machine-add", kind: "dialog", width: 560 }); }).child("⚠")))
        .when(!collapsed, el => el.child(icon))
        .when(collapsed, el => el.child(div().relative().flex_none().child(icon).when(Boolean(m), el => el.child(badge))))
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected && !rebuilt && !login, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(rebuilt, el => el.child(h_flex().flex_none().gap(3).items_center()
            .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
            .child(div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
              .hover(s => s.text_color(t.foreground))
              .tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
              .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
              .child(repair?.busy ? "Connecting…" : "Connect"))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { machine: m ?? "" }); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", { machine: m ?? "" }))
        .when(collapsed, el => el.w(RAIL_CELL).rounded(6).justify_center().tooltip(`New space on ${m ?? "this computer"}`)
          .child(h_flex().size(18).rounded(5).border_1().border_color(t.dim).items_center().justify_center()
            .child(svg("mods/workspace-chrome/plus.svg").size(10))))
        .when(!collapsed, el => el.child(svg("mods/workspace-chrome/plus.svg").size(12)).child("New space there"));
      if (!collapsed && rebuilt) { before += 1; return [head]; }
      const cell = collapsed ? railCell : (el) => el;
      const guidance = !collapsed && login ? [v_flex().px(8).pb(6).gap(3).flex_none()
        .child(div().text_size(11).text_color(t.blocked).child("needs a login: run"))
        .child(h_flex().gap(5).items_center()
          .child(div().flex_1().min_w(0).truncate().tooltip(login).text_size(11).text_color(t.muted).child(login))
          .child(div().id(`machine-login-copy-${m}`).flex_none().px(5).py(2).rounded(4)
            .text_size(11).text_color(t.foreground).bg(t.raised).cursor_pointer().hover(s => s.bg(t.hover))
            .on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(login); this.copiedLogin = login; cx.notify(); })
            .child(this.copiedLogin === login ? "Copied" : "Copy")))] : [];
      const sec = folded || !mine.length ? null : this.withGroups(mine, rows, m, collapsed, t, draw);
      const items = [cell(head), ...guidance, ...(folded ? [] : sec ? sec.items : [loading(m) ? loadingRow(m) : cell(empty)])];
      if (sec?.active >= 0) this.activeAt = before + 1 + guidance.length + sec.active;
      before += items.length;
      return items;
    });
  }

  // One machine's rows (`mine`), each group's under its header; `active`: where the active space
  // (or its folded group's header) lands among `items`. A group with no space on any machine
  // shows on this computer, so it can take a dragged space.
  withGroups(mine, rows, m, collapsed, t, draw) {
    const items = [];
    let active = -1;
    const add = (r) => { if (r.w.active) active = items.length; items.push(draw(r)); };
    mine.filter((r) => !r.group).forEach(add);
    for (const g of groupsOf().list) {
      const kids = mine.filter((r) => r.group === g.id);
      if (!kids.length && (m !== null || rows.some((r) => r.group === g.id))) continue;
      const folded = this.groupFolded.has(g.id);
      const holds = kids.some((r) => r.w.active);
      if (folded && holds) active = items.length;
      items.push(this.groupHead(g, kids.length, folded, holds, m, collapsed, t));
      if (!folded) kids.forEach(add);
    }
    return { items, active };
  }

  // A group's header: click folds it, right-click for its menu, drop a space on it to put it there.
  // Drag a header onto another to put the group there.
  groupHead(g, count, folded, holds, m, collapsed, t) {
    const target = `group:${g.id}`;
    const dropping = this.pressed !== null && this.over === target;
    const list = groupsOf().list;
    const at = list.findIndex((x) => x.id === g.id);
    const fromAt = this.pressedGroup ? list.findIndex((x) => x.id === this.pressedGroup) : -1;
    const lands = fromAt >= 0 && this.overGroup === g.id && fromAt !== at;
    const el = h_flex().id(`group-${m ?? "local"}-${g.id}`).relative().flex_none().items_center().cursor_pointer()
      .when(dropping, (el) => el.bg(t.hover).border_1().border_color(t.accent))
      .when(!dropping, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.pressedGroup === g.id && this.overGroup && this.overGroup !== g.id, (el) => el.opacity(0.5))
      .when(lands, (el) => el.child(div().absolute().left(0).right(0).h(2).bg(t.accent)
        .when(fromAt < at, (line) => line.bottom(0))
        .when(fromAt > at, (line) => line.top(0))))
      .on_mouse_down("left", () => { this.pressedGroup = g.id; this.overGroup = g.id; })
      .on_click((_e, cx) => {
        this.groupFolded.has(g.id) ? this.groupFolded.delete(g.id) : this.groupFolded.add(g.id);
        localStorage.setItem("groups.folded", JSON.stringify([...this.groupFolded]));
        cx.notify();
      })
      .on_mouse_down("right", () => openOverlay({ mod: "leddt-spaces", kind: "popup", width: 200, height: 220, props: { groupHead: { group: g.id } } }))
      .on_mouse_move((_e, cx) => {
        if (this.pressedGroup && this.overGroup !== g.id) { this.overGroup = g.id; cx.notify(); }
        if (this.pressed === null) return;
        const source = spaces().find((s) => s.id === this.pressed);
        const over = source && (source.machine ?? null) === m ? target : null;
        if (this.over !== over) { this.over = over; cx.notify(); }
      })
      .on_mouse_up("left", (_e, cx) => {
        const fromGroup = this.pressedGroup;
        this.pressedGroup = null;
        this.overGroup = null;
        if (fromGroup && fromGroup !== g.id) {
          const now = groupsOf();
          const from = now.list.findIndex((x) => x.id === fromGroup);
          const to = now.list.findIndex((x) => x.id === g.id);
          if (from >= 0 && to >= 0) {
            const list = [...now.list];
            list.splice(to, 0, list.splice(from, 1)[0]);
            setShared(GROUPS, { list, of: now.of });
          }
          cx.stop_propagation();
          cx.notify();
          return;
        }
        const from = this.pressed;
        if (from !== null && this.over === target) {
          this.pressed = null;
          this.over = null;
          setGroup(from, g.id);
          cx.stop_propagation();
          cx.notify();
        }
      });
    if (collapsed) {
      return railCell(el.w(RAIL_CELL).h(folded ? 20 : 12).mt(4).rounded(6).justify_center()
        .tooltip(`${g.name} (${count})${folded ? " · folded" : ""}`)
        .child(folded
          ? svg("mods/workspace-chrome/folder.svg").size(12).text_color(holds ? t.foreground : t.dim)
          : div().w(16).h(1).bg(t.border)));
    }
    return el.h(26).mt(6).px(8).gap(7).rounded(7).text_size(11.5).text_color(holds && folded ? t.foreground : t.dim)
      .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(13).flex_none())
      .child(div().flex_1().min_w(0).truncate().font_medium().child(g.name))
      .child(div().flex_none().text_size(11).child(String(count)));
  }

  // The second line: the branch (the repo when detached), else the folder; then ahead/behind.
  subline(g, cwd, t) {
    const label = g ? g.branch ?? g.name : shortPath(cwd);
    return h_flex()
      .min_w(0)
      .gap(5)
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .child(div().flex_1().min_w(0).truncate().child(label ?? ""))
      .when(g?.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g?.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  // The branch's open pull request, at the right of the first line; a click opens it.
  prChip(w, pr, t) {
    return div()
      .id(`space-pr-${w.id}`)
      .flex_none()
      .px(4)
      .rounded(4)
      .text_size(11)
      .font_medium()
      .text_color(pr.draft ? t.dim : t.accent)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(`${pr.draft ? "Draft pull request" : "Pull request"} #${pr.number}: open in the browser`)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        openUrl(pr.url).catch(() => {});
      })
      .child(`#${pr.number}`);
  }

  row({ w, i, g, tree, cwd, group }, t) {
    const on = w.active;
    const fromIndex = this.pressed === null ? -1 : spaces().findIndex(s => s.id === this.pressed);
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    const pr = g?.branch ? this.prs[prKey(g)] : null;
    const src = this.iconSource(w, g);
    const icon = src ? this.icons[src.key] : null;
    const avatar = icon
      ? image(icon).size(18).flex_none().rounded(4)
      : h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff").child(spaceAvatar(w.name));
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.pressed === w.id && this.over !== w.id, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === w.id && this.pressed !== w.id, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(fromIndex < i, line => line.bottom(0))
          .when(fromIndex > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = w.id;
        this.over = w.id;
      })
      .on_mouse_move((_e, cx) => {
        // A group dragged over a space: no longer over a header, so it won't land.
        if (this.pressedGroup && this.overGroup) { this.overGroup = null; cx.notify(); }
        const source = spaces().find(s => s.id === this.pressed);
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? w.id : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === w.id && from !== w.id) {
          // Dropped among another group's spaces: it joins that group.
          const of = groupsOf().of;
          if ((of[from] ?? null) !== (group ?? null)) setGroup(from, group);
          const index = spaces().findIndex(s => s.id === w.id);
          if (index !== -1) run("space.move", { id: from, index: index + 1 });
        } else if (from === w.id) run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .child(
        h_flex()
          .gap(9)
          .items_center()
          .when(Boolean(tree), el => el.pl(22).child(svg("mods/workspace-chrome/branch.svg").size(13).flex_none().text_color(t.dim)))
          .when(!tree, el => el.child(avatar))
          .child(v_flex().flex_1().min_w(0).gap(1)
            .child(h_flex().min_w(0).gap(6).items_center()
              .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(w.name))
              .when(Boolean(pr), el => el.child(this.prChip(w, pr, t))))
            .child(this.subline(g, cwd, t))),
      );
  }

  compact({ w, i }, t) {
    return railCell(h_flex()
      .id(`space-${w.id}`)
      .relative()
      .w(RAIL_CELL)
      .h(26)
      .rounded(6)
      .justify_center()
      .items_center()
      .when(w.active, (el) => el.bg(t.selected))
      .when(!w.active, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().absolute().right(5).text_color(tone(t, w.status)).child(glyph(w.status))));
  }

  // Each space's avatar for other mods (leddt-agents): { [space]: { icon, fill, letter } },
  // icon the copy image() reads, else null for the letter on its color. Written only when it changes.
  publishAvatars(sp, colors, t) {
    const ps = panes();
    const all = {};
    for (const s of sp) {
      const src = this.iconSource(s, this.git[where(s, ps)]);
      const color = colors[s.id] ?? "ansi6";
      all[s.id] = {
        icon: (src && this.icons[src.key]) || null,
        fill: color.startsWith("#") ? color : (MARK[color] ?? t[color]),
        letter: spaceAvatar(s.name),
      };
    }
    const json = JSON.stringify(all);
    if (json === this.avatarsJson) return;
    this.avatarsJson = json;
    setShared(AVATARS, all);
  }

  render() {
    const t = theme();
    const p = props();
    if (p?.groupName) return this.groupNameDialog(t);
    if (p?.groupMenu) return this.groupMenu(t);
    if (p?.groupHead) return this.groupHeadMenu(t);
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    this.publishAvatars(sp, kept, t);
    // A closed space leaves its group (only this computer's: another machine's may just be away).
    for (const s of sp) if (!s.machine) this.localSeen.add(s.id);
    const grouped = groupsOf();
    const gone = Object.keys(grouped.of).filter((id) => this.localSeen.has(id) && !ids.has(id));
    if (gone.length) setShared(GROUPS, { list: grouped.list, of: Object.fromEntries(Object.entries(grouped.of).filter(([id]) => !gone.includes(id))) });
    const list = this.grouped(t, collapsed);
    // Bring the active space into view when it, or its place in the list, changes; a row already in view stays put.
    const active = sp.find(p => p.active)?.id;
    if (active !== this.revealed || this.activeAt !== this.revealedAt) {
      this.revealed = active;
      this.revealedAt = this.activeAt;
      if (this.activeAt >= 0) this.scroll.scroll_to_item(this.activeAt);
    }
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(collapsed, el => el.pl(0).pr(0).justify_center())
        .when(!collapsed, el => el.child(div().flex_1().child("Spaces"))
          .child(div().id("group-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
            .tooltip("New group")
            .on_click(() => openOverlay({ mod: "leddt-spaces", kind: "dialog", width: 380, height: 190, props: { groupName: {} } }))
            .child(svg("mods/workspace-chrome/folder-plus.svg").size(14))))
        .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("space.new")).child(svg("mods/workspace-chrome/plus.svg").size(14))))
      .child(v_flex().flex_1().min_h(0).px(collapsed ? 0 : 8).pb(14).overflow_y_scrollbar().mode("always").track_scroll(this.scroll)
        // A block above (another mod's) growing, or the window resizing, shrinks this list and can push the active space out.
        .on_size_change((_size, cx) => { if (this.activeAt >= 0) { this.scroll.scroll_to_item(this.activeAt); cx.notify(); } })
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; this.pressedGroup = null; this.overGroup = null; cx.notify(); })
        .children(list));
  }
}
