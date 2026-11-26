// A pane that renders a markdown file (props: { file (absolute), on }), opened from leddt-files.
// It follows the file as it changes, and a link to another .md file opens it here (← goes back).
// leddt-files reuses it for another file: leddt-preview.show { [props.id]: { file, on, at } }.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextView, Editor, EditorState } from "gpui-base";
import { props, readTextFile, watchFolder, exec, theme, window, notify, shared, settings } from "herdr";

const SHOW = "leddt-preview.show";

const MAX = 400000;
// Code blocks: font size, and line height in pixels (the editor's own, for a block's height).
const CODE_SIZE = 13, CODE_LINE = 21;
// The editor lets its text scroll past the end by about half its own height. It's made twice as tall
// as its code (plus a few lines), and clipped to the code, so it has nothing to scroll.
const codeHeight = (lines) => (lines * 2 + 4) * CODE_LINE;
const dirname = (p) => p.replace(/[\\/][^\\/]*$/, "");
const basename = (p) => p.split(/[\\/]/).pop();
// Joins a relative link to a folder, folding "." and "..".
function resolve(dir, rel) {
  const out = [];
  for (const part of `${dir}/${rel}`.replace(/\\/g, "/").split("/")) {
    if (part === "..") { if (out.length > 1) out.pop(); }
    else if (part !== "." && (part || !out.length)) out.push(part);
  }
  return out.join("/");
}
// A YAML frontmatter block becomes a key/value table, its values shown as written (plain text, one line per line).
// A frontmatter it can't read (a line that isn't "key: value" nor indented under a key) is left as is.
// Every ASCII punctuation is escaped so a value never turns into markdown (__tests__ stays as is).
const plain = (s) => s.replace(/[!-\/:-@\[-`{-~]/g, "\\$&");
// Returns { table, body }, table being null when there's no frontmatter it can read.
function frontmatter(text) {
  const none = { table: null, body: text };
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return none;
  const rows = [];
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const top = /^([^\s#:][^:]*?):(?:[ \t]+(.*))?$/.exec(line);
    if (top) { rows.push({ key: top[1].trim(), lines: top[2]?.trim() ? [top[2].trim()] : [] }); continue; }
    if (!rows.length || !/^\s/.test(line)) return none;
    rows.at(-1).lines.push(line.replace(/\s+$/, ""));
  }
  if (!rows.length) return none;
  // Lines under a key keep their indentation relative to each other.
  const value = ({ lines }) => {
    const nested = lines.filter(l => /^\s/.test(l));
    const indent = Math.min(...nested.map(l => l.match(/^\s*/)[0].length));
    return lines.map(l => /^\s/.test(l)
      ? "&nbsp;".repeat(l.match(/^\s*/)[0].length - indent) + plain(l.trim())
      : plain(l)).join("<br>");
  };
  const table = ["| Key | Value |", "| --- | --- |", ...rows.map(r => `| ${plain(r.key)} | ${value(r)} |`)];
  return { table: table.join("\n"), body: text.slice(m[0].length) };
}

// Splits the body into Markdown runs and fenced code blocks that name a language ({ code, lang }),
// so those are drawn by a read-only Editor with syntax colours. Only fences indented 0-3 spaces count
// (a block inside a list item stays Markdown); a fence without a language stays Markdown too.
const LANG = { ts: "js", typescript: "js", tsx: "js", jsx: "js", javascript: "js", mjs: "js", cjs: "js", mts: "js", cts: "js",
  jsonc: "json", json5: "json", yml: "yaml", toml: "yaml", svelte: "html", vue: "html", xml: "html", htm: "html",
  py: "python", rb: "ruby", rs: "rust", sh: "bash", shell: "bash", zsh: "bash", console: "bash", golang: "go",
  "c#": "csharp", cs: "csharp", "c++": "cpp", hpp: "cpp", cc: "cpp", h: "c", md: "markdown", patch: "diff", makefile: "make" };
function segments(text) {
  const out = [], lines = text.split("\n");
  let md = [];
  const flush = () => { if (md.length) out.push({ md: md.join("\n") }); md = []; };
  for (let i = 0; i < lines.length; i++) {
    const open = /^( {0,3})(`{3,}|~{3,})[ \t]*\{?\.?([\w#+-]*)[^`]*$/.exec(lines[i].replace(/\r$/, ""));
    if (!open) { md.push(lines[i]); continue; }
    const [, indent, fence, lang] = open;
    const close = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`);
    let end = i + 1;
    while (end < lines.length && !close.test(lines[end].replace(/\r$/, ""))) end++;
    if (!lang) { md.push(...lines.slice(i, end + 1)); i = end; continue; }
    flush();
    const code = lines.slice(i + 1, end).map(l => l.replace(/\r$/, "").replace(new RegExp(`^ {0,${indent.length}}`), ""));
    const name = lang.toLowerCase();
    out.push({ code: code.join("\n"), lang: LANG[name] ?? name });
    i = end;
  }
  flush();
  return out;
}

function openExternal(url) {
  const platform = window()?.platform;
  const r = platform === "windows" ? exec("powershell", ["-NoProfile", "-Command", "Start-Process", url])
    : exec(platform === "macos" ? "open" : "xdg-open", [url]);
  r.then(r => { if (r.code !== 0) throw new Error(r.stderr); })
    .catch(e => notify({ title: "Couldn't open the link", body: String(e), level: "error" }));
}

export default class Markdown extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.on = p.on ?? null;
    this.id = p.id ?? null;
    this.handledAt = this.id ? shared(SHOW)?.[this.id]?.at ?? null : null;
    this.history = [];
    this.open(p.file ?? null, cx);
    // A remote file can't be watched: read it again now and then.
    cx.timer.every(5000, cx => { if (this.on) this.load(cx); });
  }

  // A file sent by leddt-files to this pane: fresh, and once (the value persists).
  showRequested(cx) {
    const req = this.id ? shared(SHOW)?.[this.id] : null;
    if (!req || req.at === this.handledAt) return;
    this.handledAt = req.at;
    if (Date.now() - req.at >= 10000 || !req.file) return;
    this.on = req.on ?? null; this.history = [];
    this.open(req.file, cx);
  }

  open(file, cx) {
    this.file = file; this.text = null; this.error = file ? null : "No file"; this.fmOpen = false;
    this.load(cx);
    this.watch(cx);
  }

  load(cx) {
    const file = this.file;
    if (!file) return;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(file, { on: this.on });
        if (this.file !== file) return;
        if (text === null) { this.error = "This file is no longer available"; return; }
        if (text !== this.text) {
          this.text = text; this.error = null;
          this.shown = frontmatter(text.length > MAX ? text.slice(0, MAX) + "\n\n… (file truncated)" : text);
          this.parts = this.codeViews(segments(this.shown.body));
        }
      } catch (e) { if (this.file === file) this.error = `Cannot read this file: ${e}`; }
      finally { cx.notify(); }
    });
  }

  // Gives each code block an editor, reusing the previous one for a block that didn't change.
  codeViews(parts) {
    const old = (this.parts ?? []).filter(p => p.state);
    const t = theme(), font = settings().font_family;
    for (const p of parts) {
      if (p.md !== undefined) continue;
      const at = old.findIndex(o => o.lang === p.lang && o.code === p.code);
      if (at >= 0) { p.state = old.splice(at, 1)[0].state; continue; }
      p.state = EditorState.new({ language: p.lang, value: p.code, readonly: true, line_numbers: false, folding: false,
        ...(font ? { font_family: font } : {}), font_size: CODE_SIZE,
        syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
    }
    for (const p of old) p.state.release();
    return parts;
  }

  // Watches the file's folder (local only) and reads the file again when it changes.
  watch(cx) {
    if (this.on || !this.file) return;
    const dir = dirname(this.file);
    if (this.watched === dir) return;
    this.watched = dir;
    cx.spawn(async cx => {
      try {
        while (this.watched === dir) {
          const changed = await watchFolder(dir);
          if (this.watched !== dir) return;
          if (changed.some(p => p === this.file || p === dir || p.replace(/\\/g, "/") === this.file.replace(/\\/g, "/"))) this.load(cx);
        }
      } catch { if (this.watched === dir) this.watched = null; }
    });
  }

  link(url, cx) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^file:/i.test(url)) return openExternal(url);
    const path = decodeURIComponent(url.replace(/^file:\/\//i, "").replace(/[#?].*$/, ""));
    if (!path) return; // An anchor in this file: nothing to scroll to.
    const target = /^([a-z]:)?[\\/]/i.test(path) ? path : resolve(dirname(this.file), path);
    if (/\.(md|markdown|mdx)$/i.test(target)) { this.history.push(this.file); this.open(target, cx); cx.notify(); }
    else if (!this.on) openExternal(target);
  }

  render(cx) {
    this.showRequested(cx);
    const t = theme();
    return v_flex().id("markdown").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(14)
      .when(this.history.length > 0, el => el.child(h_flex().h(30).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border).text_size(12)
        .child(div().id("md-back").px(6).rounded(5).cursor_pointer().text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { this.open(this.history.pop(), cx); cx.notify(); }).child("←"))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(basename(this.file ?? "")))))
      .child(this.text !== null
        ? div().id("md-scroll").flex_1().min_h(0).overflow_y_scrollbar().px(24).py(16)
            .when(!!this.shown.table, el => el.child(v_flex().mb(16).border(1).border_color(t.border).rounded(6)
              .child(h_flex().id("md-fm").h(28).px(10).gap(6).items_center().cursor_pointer().text_size(12).text_color(t.muted)
                .hover(s => s.bg(t.hover).text_color(t.foreground))
                .on_click((_e, cx) => { this.fmOpen = !this.fmOpen; cx.notify(); })
                .child(this.fmOpen ? "▾" : "▸").child("Frontmatter"))
              .when(this.fmOpen, el => el.child(div().px(10).pb(10).border_t(1).border_color(t.border).pt(10)
                .child(TextView.markdown(`md-fm-${this.file}`, this.shown.table).selectable(true))))))
            .children(this.parts.map((p, i) => p.state
              ? div().my(8).px(10).py(8).rounded(6).border(1).border_color(t.border).flex_none()
                  .child(div().h(p.code.split("\n").length * CODE_LINE).overflow_hidden()
                    .child(Editor.new(p.state).w_full().h(codeHeight(p.code.split("\n").length))))
              : TextView.markdown(`md-${this.file}-${i}`, p.md).selectable(true).on_link_click((url, cx) => this.link(url, cx))))
        : div().p(16).text_size(12).text_color(t.dim).child(this.error || "Loading…"));
  }
}
