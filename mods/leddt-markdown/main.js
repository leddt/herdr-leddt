// A pane that renders a markdown file (props: { file (absolute), on }), opened from leddt-files.
// It follows the file as it changes, and a link to another .md file opens it here (← goes back).
import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { props, readTextFile, watchFolder, exec, theme, window, notify } from "herdr";

const MAX = 400000;
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
    this.history = [];
    this.open(p.file ?? null, cx);
    // A remote file can't be watched: read it again now and then.
    if (this.on) cx.timer.every(5000, cx => this.load(cx));
  }

  open(file, cx) {
    this.file = file; this.text = null; this.error = file ? null : "No file";
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
        if (text !== this.text) { this.text = text.length > MAX ? text.slice(0, MAX) + "\n\n… (file truncated)" : text; this.error = null; }
      } catch (e) { if (this.file === file) this.error = `Cannot read this file: ${e}`; }
      finally { cx.notify(); }
    });
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

  render() {
    const t = theme();
    return v_flex().id("markdown").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(14)
      .when(this.history.length > 0, el => el.child(h_flex().h(30).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border).text_size(12)
        .child(div().id("md-back").px(6).rounded(5).cursor_pointer().text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { this.open(this.history.pop(), cx); cx.notify(); }).child("←"))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(basename(this.file ?? "")))))
      .child(this.text !== null
        ? div().id("md-scroll").flex_1().min_h(0).overflow_y_scrollbar().px(24).py(16)
            .child(TextView.markdown(`md-${this.file}`, this.text).selectable(true).on_link_click((url, cx) => this.link(url, cx)))
        : div().p(16).text_size(12).text_color(t.dim).child(this.error || "Loading…"));
  }
}
