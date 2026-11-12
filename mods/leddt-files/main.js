// A lazy file browser for the focused pane's folder, with bounded read-only previews.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, shared, notify, appHome } from "herdr";

// Set by leddt-changes (double-click on a changed file): { path (absolute), on, at }.
const OPEN_IN_FILES = "leddt-files.open";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const ps = panes(), pane = f?.pane ? ps.find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  // A mod pane (leddt-review's Findings…) has no folder: its tab's first terminal's.
  const tabCwd = pane?.mod ? ps.find(p => p.tab === pane.tab && p.terminal && p.cwd)?.cwd : null;
  // A mod pane can name its own folder, even beside a terminal (leddt.pane-folders: { [pane]: folder }).
  const modCwd = pane?.mod ? shared("leddt.pane-folders")?.[pane.pane] ?? null : null;
  return { cwd: pane?.cwd || modCwd || tabCwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
// Opens the folder Files is showing in Zed (its git repo root when inside one).
async function openInZed(folder) {
  try {
    const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder }).catch(() => null);
    const target = top?.code === 0 && top.stdout.trim() ? top.stdout.trim() : folder;
    // Zed's CLI is "zeditor" on Linux packages and "zed" elsewhere (Windows, macOS).
    await exec("zeditor", [target]).catch(() => exec("zed", [target]));
  } catch (e) { console.log("Open in Zed failed:", String(e)); }
}
// PowerShell takes curly single quotes as quotes too: they're doubled like '.
const psQuote = (s) => "'" + s.replace(/['‘’‚‛]/g, "$&$&") + "'";
const extension = (name) => { const i = name.lastIndexOf("."); return i > 0 ? name.slice(i + 1).toLowerCase() : null; };
// The system's default app for each extension: { name, icon? } or null when there's none.
// Windows asks the shell (user choice included) for the app's name, all extensions
// in one call. A Store app (Photos) has a name but no executable; a type that only
// runs itself (.exe, .bat) or that nothing opens has no name. An app picked with
// "Open with" (Applications\Zed.exe) has no default verb: it answers for "open".
// The icon is the executable's; without one (a Store app), the file type's. It's
// saved as a PNG under the Herdr home, the only place image() reads.
const ICON_DIR = "data/leddt-files-icons";
async function defaultApps(exts, sample) {
  const out = {};
  if (window()?.platform === "windows") {
    const script = [
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
      "Add-Type -AssemblyName System.Drawing",
      "Add-Type -Name A -Namespace LeddtFiles -MemberDefinition '"
        + "[DllImport(\"shlwapi.dll\", CharSet = CharSet.Unicode)] public static extern uint AssocQueryString(int f, int s, string a, string v, System.Text.StringBuilder o, ref uint n); "
        + "[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct FI { public IntPtr hIcon; public int iIcon; public uint attr; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string name; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string type; } "
        + "[DllImport(\"shell32.dll\", CharSet = CharSet.Unicode)] public static extern IntPtr SHGetFileInfo(string p, uint a, ref FI fi, uint n, uint f);'",
      "function q($e, $s) { foreach ($v in $null, 'open') { $n = [uint32]1024; $b = New-Object System.Text.StringBuilder 1024; if ([LeddtFiles.A]::AssocQueryString(0x400, $s, $e, $v, $b, [ref]$n) -eq 0) { return $b.ToString() } } }",
      `$dir = ${psQuote(`${appHome()}/${ICON_DIR}`.replace(/\//g, "\\"))}; $null = New-Item -ItemType Directory -Force $dir`,
      "$r = @{}",
      "foreach ($e in @(" + exts.map(e => psQuote("." + e)).join(",") + ")) { $name = q $e 4; if (-not $name) { continue }; $exe = q $e 2; $file = $null; $icon = $null; "
        + "try { if ($exe -and (Test-Path -LiteralPath $exe)) { $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($exe); $file = ($name -replace '[^A-Za-z0-9]+', '-').ToLower() + '.png' } "
        + "if (-not $icon) { $fi = New-Object LeddtFiles.A+FI; $null = [LeddtFiles.A]::SHGetFileInfo('x' + $e, 0x80, [ref]$fi, [Runtime.InteropServices.Marshal]::SizeOf($fi), 0x110); if ($fi.hIcon -ne [IntPtr]::Zero) { $icon = [System.Drawing.Icon]::FromHandle($fi.hIcon); $file = 'type-' + $e.Substring(1).ToLower() + '.png' } } "
        + "if ($icon) { $icon.ToBitmap().Save((Join-Path $dir $file), [System.Drawing.Imaging.ImageFormat]::Png) } else { $file = $null } } catch { $file = $null }; "
        + "$r[$e.Substring(1)] = @{ name = $name; icon = $file } }",
      "$r | ConvertTo-Json -Compress",
    ].join("; ");
    const r = await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
    if (r.code !== 0) throw new Error(r.stderr || "Default app lookup failed");
    const found = JSON.parse(r.stdout || "{}");
    for (const e of exts) out[e] = found[e]?.name ? { name: found[e].name, icon: found[e].icon ? `${ICON_DIR}/${found[e].icon}` : null } : null;
  } else if (window()?.platform === "linux") {
    // xdg-mime answers per file: each extension asks about one of its files.
    for (const e of exts) {
      const r = await exec("sh", ["-c", 'm=$(xdg-mime query filetype "$1") && xdg-mime query default "$m"', "files", sample[e]]).catch(() => null);
      const app = r?.code === 0 ? r.stdout.trim().replace(/\.desktop$/, "") : "";
      out[e] = app ? { name: app } : null;
    }
  } else for (const e of exts) out[e] = null;
  return out;
}
function openWithDefault(file) {
  const win = window()?.platform === "windows";
  const run = win ? exec("powershell", ["-NoProfile", "-Command", "Invoke-Item -LiteralPath " + psQuote(file.replace(/\//g, "\\"))]) : exec("xdg-open", [file]);
  run.then(r => { if (r.code !== 0) throw new Error(r.stderr); })
    .catch(e => notify({ title: "Couldn't open the file", body: String(e), level: "error" }));
}
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } " + psQuote(path)], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    // Extension → default app ({ name } or null), for local files; looked up on hover.
    this.apps = new Map(); this.looking = new Set(); this.hovered = null;
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  // The default apps of every extension listed and not known yet, in one lookup.
  lookupApps(cx) {
    const sample = {};
    for (const [prefix, list] of this.entries) for (const entry of list) {
      const ext = !entry.dir && extension(entry.name);
      if (ext && !this.apps.has(ext) && !this.looking.has(ext) && !sample[ext]) sample[ext] = `${this.root}/${prefix ? prefix + "/" : ""}${entry.name}`;
    }
    const exts = Object.keys(sample);
    if (!exts.length) return;
    for (const e of exts) this.looking.add(e);
    cx.spawn(async cx => {
      try { for (const [e, app] of Object.entries(await defaultApps(exts, sample))) this.apps.set(e, app); }
      catch (e) { console.log("Default app lookup failed:", String(e)); for (const e of exts) this.apps.set(e, null); }
      finally { for (const e of exts) this.looking.delete(e); cx.notify(); }
    });
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      const app = this.hovered === path && !this.on && !entry.dir ? this.apps.get(extension(entry.name)) : null;
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_hover((on, cx) => {
          if (on) { this.hovered = path; if (!entry.dir && !this.on) this.lookupApps(cx); }
          else if (this.hovered === path) this.hovered = null;
          cx.notify();
        })
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx))
        .child(entry.dir ? svg(`mods/leddt-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/leddt-files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(app), el => el.child(div().id(`file-open-${path}`).flex_none().p(3).rounded(5)
          .text_color(t.muted).cursor_pointer().hover(s => s.bg(t.background).text_color(t.foreground))
          .tooltip(`Open with ${app.name}`)
          .on_click((_e, cx) => { cx.stop_propagation(); openWithDefault(`${this.root}/${path}`); })
          .child(app.icon ? image(app.icon).size(14) : svg("mods/leddt-files/open-external.svg").size(13))))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  // A file asked for elsewhere (a double-click in leddt-changes): shown here, its
  // folders opened in the tree. Only a fresh request, once: the value persists.
  openRequested(cx) {
    const req = shared(OPEN_IN_FILES);
    if (!req?.path || req.at === this.handledAt || Date.now() - req.at > 10000) return;
    this.handledAt = req.at;
    if (!this.root || (req.on ?? null) !== (this.on ?? null)) return;
    const norm = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "");
    const win = window()?.platform === "windows", same = (a, b) => win ? a.toLowerCase() === b.toLowerCase() : a === b;
    const root = norm(this.root), file = norm(req.path);
    // Files browses the focused pane's folder, which can be below the repo root.
    if (!same(file.slice(0, root.length + 1), root + "/")) {
      notify({ title: "Not in the Files folder", body: `${file} is outside ${root}.`, level: "warning" });
      return;
    }
    const rel = file.slice(root.length + 1), parts = rel.split("/");
    // This runs in render, where cx.notify() throws: no toggle() here. The folders
    // open at once and load in a task, which notifies when it's done.
    const missing = [];
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join("/");
      this.folders.add(folder);
      if (!this.entries.has(folder) && !this.pending.has(folder)) { this.pending.add(folder); missing.push(folder); }
    }
    if (missing.length) {
      const context = this.context;
      cx.spawn(async cx => {
        for (const folder of missing) {
          try { await this.loadFolder(folder, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(folder); }
        }
        cx.notify();
      });
    }
    this.show(rel, cx);
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    this.openRequested(cx);
    const t = theme();
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? this.root?.split(/[\\/]/).pop() ?? ""))
        .when(Boolean(this.root) && !this.on, el => el.child(div().id("files-zed").flex_none().px(8).py(2).rounded(6).border_1().border_color(t.border)
          .text_size(12).text_color(t.muted).cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => { openInZed(this.root); }).child("Open in Zed"))))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }
}
