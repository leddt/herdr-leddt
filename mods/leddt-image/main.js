// A pane that shows an image file (props: { file (absolute) }), opened from leddt-files.
// image() only reads under the app folder: the image is shown from a copy in data/leddt-image/,
// made again when the file changes. An SVG's copy is the same text with its width and height
// set to twice the shown size, so GPUI draws it sharp at any zoom. Works on Linux, macOS, Windows.
// Zoom bar from compagnons-forge's graph view; drag or wheel to move, Ctrl+wheel to zoom.
// leddt-files reuses it for another image: leddt-preview.show { [props.id]: { file, at } }.
import { View, div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, exec, appHome, watchFolder, readTextFile, writeTextFile, window, theme, shared } from "herdr";

const ZOOMS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4, 6, 8];
const MIN = 0.01, MAX = 8, PAD = 16;
// An SVG is drawn at twice its shown size (sharp on HiDPI too), up to this many pixels a side.
const DENSITY = 2, MAX_PX = 8192;
const dirname = (p) => p.replace(/[\\/][^\\/]*$/, "");
const isSvg = (p) => /\.svg$/i.test(p);
const SHOW = "leddt-preview.show";

// ----- copies (the same code is in leddt-files)
const COPIES = "data/leddt-image";
const hash = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.codePointAt(0), 16777619); return (h >>> 0).toString(36); };
// PowerShell takes curly single quotes as quotes too: they're doubled like '.
const psQuote = (s) => "'" + s.replace(/['‘’‚‛]/g, "$&$&") + "'";
// Deletes the copies named <key>-* and any made over a day ago, then copies file there as name.
async function prepare(key, file, name) {
  const dir = `${appHome()}/${COPIES}`;
  const r = window()?.platform === "windows"
    ? await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command",
        `$d = ${psQuote(dir.replace(/\//g, "\\"))}; New-Item -ItemType Directory -Force -Path $d | Out-Null; `
        + `Get-ChildItem -LiteralPath $d -File | Where-Object { $_.CreationTime -lt (Get-Date).AddDays(-1) -or $_.Name.StartsWith(${psQuote(key + "-")}) } | Remove-Item -Force -ErrorAction SilentlyContinue; `
        + (file ? `Copy-Item -LiteralPath ${psQuote(file.replace(/\//g, "\\"))} -Destination (Join-Path $d ${psQuote(name)})` : "")])
    : await exec("sh", ["-c", 'mkdir -p "$1" && { find "$1" -type f -mtime +1 -delete; rm -f "$1/$2"-*; } 2>/dev/null; [ -z "$3" ] || cp "$3" "$1/$4"',
        "sh", dir, key, file ?? "", name ?? ""]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "copy failed");
}
// An SVG's size in pixels, from its root's width/height, else its viewBox (300×150 without either).
function svgSize(text) {
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0] ?? "";
  const attr = (n) => new RegExp(`\\s${n}\\s*=\\s*(["'])(.*?)\\1`, "i").exec(tag)?.[2];
  const num = (v) => { const m = /^\s*([\d.]+)\s*(px)?\s*$/i.exec(v ?? ""); return m ? Number(m[1]) || null : null; };
  const vb = attr("viewBox")?.trim().split(/[\s,]+/).map(Number), vw = vb?.length === 4 ? vb[2] : null, vh = vb?.length === 4 ? vb[3] : null;
  let w = num(attr("width")), h = num(attr("height"));
  if (!w && !h) { w = vw || 300; h = vh || 150; }
  else if (!w) w = vw && vh ? h * vw / vh : h;
  else if (!h) h = vw && vh ? w * vh / vw : w;
  return { w, h };
}
// The SVG drawn W×H pixels: its root's width and height replaced (a viewBox added when it has none).
function svgSized(text, W, H) {
  const m = /<svg\b[^>]*>/i.exec(text);
  if (!m) return text;
  const { w, h } = svgSize(text);
  let tag = m[0].replace(/\s(width|height)\s*=\s*(["']).*?\2/gi, "");
  const box = /\sviewBox\s*=/i.test(tag) ? "" : ` viewBox="0 0 ${w} ${h}"`;
  tag = tag.replace(/^<svg\b/i, `<svg width="${W}" height="${H}"${box}`);
  return text.slice(0, m.index) + tag + text.slice(m.index + m[0].length);
}
// A copy of the SVG drawn W×H, or of any other image; its path for image().
async function imageCopy(key, file, ext, svgText, W, H) {
  const name = `${key}-${Date.now()}.${svgText != null ? "svg" : ext}`;
  if (svgText != null) {
    await prepare(key);
    await writeTextFile(`${appHome()}/${COPIES}/${name}`, svgSized(svgText, W, H), null);
  } else await prepare(key, file, name);
  return `${COPIES}/${name}`;
}
// -----

export default class Image extends View {
  init(_props, cx) {
    this.id = props()?.id ?? null;
    this.handledAt = this.id ? shared(SHOW)?.[this.id]?.at ?? null : null;
    this.version = 0;
    this.open(props()?.file ?? null, cx);
  }

  // Shows another file, from the start.
  open(file, cx) {
    this.file = file;
    this.key = hash(`${this.file}|${Math.random()}`); // its own copies, even beside another pane on this file
    this.ext = /\.([a-z0-9]+)$/i.exec(this.file ?? "")?.[1]?.toLowerCase() ?? "img";
    this.svg = isSvg(this.file ?? "");
    this.info = null; // { w, h }: an SVG's from its text, another image's measured once shown
    this.svgText = null;
    this.src = null; this.srcWant = null; this.loading = null;
    this.error = this.file ? null : "No file";
    this.fitMode = true; this.zoom = 1;
    this.pan = { x: 0, y: 0 }; // the scroll, in shown pixels
    this.drag = null;
    this.load(cx);
    this.watch(cx);
  }

  // A file sent by leddt-files to this pane: fresh, and once (the value persists).
  showRequested(cx) {
    const req = this.id ? shared(SHOW)?.[this.id] : null;
    if (!req || req.at === this.handledAt) return;
    this.handledAt = req.at;
    if (Date.now() - req.at < 10000 && req.file) this.open(req.file, cx);
  }

  // Reads the file again: an SVG's text (drawn by want()), or a new copy of another image.
  load(cx) {
    if (!this.file) return;
    const version = ++this.version;
    cx.spawn(async cx => {
      try {
        if (this.svg) {
          const text = await readTextFile(this.file);
          if (text === null) throw new Error("this file is no longer available");
          if (version !== this.version) return;
          this.svgText = text; this.info = svgSize(text); this.srcWant = null;
        } else {
          const src = await imageCopy(this.key, this.file, this.ext);
          if (version !== this.version) return;
          if (src !== this.src) { this.src = src; this.info = null; } // measured again: it may have changed size
        }
        this.error = null;
      } catch (e) { if (version === this.version) { this.src = null; this.error = `Cannot read this image: ${e.message ?? e}`; } }
      finally { cx.notify(); }
    });
  }

  // An SVG's copy at the size it's shown. Runs from render: no cx.notify() here, only in the task.
  want(z, cx) {
    const { w, h } = this.info, k = Math.min(DENSITY * z, MAX_PX / Math.max(w, h));
    const W = Math.max(1, Math.round(w * k)), H = Math.max(1, Math.round(h * k)), want = `${this.version}|${W}x${H}`;
    if (want === this.srcWant || this.loading) return; // one at a time: when it ends, render asks for the latest size
    this.loading = want;
    cx.spawn(async cx => {
      try { this.src = await imageCopy(this.key, this.file, this.ext, this.svgText, W, H); }
      catch (e) { if (!this.src) this.error = `Cannot show this image: ${e.message ?? e}`; }
      finally { this.srcWant = want; this.loading = null; cx.notify(); }
    });
  }

  // Watches the file's folder, and reads the file again when it changes.
  watch(cx) {
    if (!this.file) return;
    const dir = dirname(this.file), same = (a, b) => a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
    if (this.watched === dir) return;
    this.watched = dir;
    cx.spawn(async cx => {
      try {
        while (this.watched === dir) {
          const changed = await watchFolder(dir);
          if (this.watched !== dir) return;
          if (changed.some(p => same(p, this.file) || same(p, dir))) this.load(cx);
        }
      } catch { if (this.watched === dir) this.watched = null; }
    });
  }

  fit() {
    const a = this.area, i = this.info;
    if (!a || !i) return null;
    const f = Math.max(MIN, Math.min((a.width - 2 * PAD) / i.w, (a.height - 2 * PAD) / i.h));
    return this.svg ? f : Math.min(1, f); // a small picture isn't blown up
  }
  current() { return this.fitMode ? this.fit() ?? 1 : this.zoom; }

  // Zooms around a point of the view (its center by default), keeping it in place.
  setZoom(z, at) {
    const was = this.current(), a = this.area ?? { width: 0, height: 0 };
    const next = Math.min(MAX, Math.max(MIN, Math.round(z * 1000) / 1000));
    const p = at ?? { x: a.width / 2, y: a.height / 2 };
    // Where the image sits in the view along an axis (centered when smaller), for this zoom.
    const origin = (len, view, pan) => len < view ? (view - len) / 2 : -pan;
    const ox = origin(this.info.w * was, a.width, this.pan.x), oy = origin(this.info.h * was, a.height, this.pan.y);
    const r = next / was;
    this.fitMode = false; this.zoom = next;
    this.pan = { x: (p.x - ox) * r - p.x, y: (p.y - oy) * r - p.y }; // render clamps it
  }

  render(cx) {
    this.showRequested(cx);
    const t = theme();
    const root = v_flex().id("image").size_full().min_h(0).bg(t.background).text_color(t.dim).text_size(12);
    if (!this.info) {
      // A copied image's size: shown once at its own size, out of sight, and measured.
      return root.child(div().p(16).child(this.error || "Loading…"))
        .when(Boolean(this.src) && !this.svg, (el) => el.child(div().id("image-measure").absolute().top(0).left(0).opacity(0)
          .on_size_change((size, cx) => {
            if (!(size.width > 0 && size.height > 0) || this.info) return;
            this.info = { w: Math.round(size.width), h: Math.round(size.height) }; cx.notify();
          })
          .child(image(this.src))));
    }
    const { w, h } = this.info, z = this.current(), fit = this.fit();
    if (this.svg) this.want(z, cx);

    const zoomBtn = (id, label, tip, enabled, onClick) => div().id(id).h(20).min_w(20).px(5).flex().items_center().justify_center().rounded(5)
      .text_size(11.5).tooltip(tip)
      .when(enabled, (el) => el.cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { onClick(); cx.notify(); }))
      .when(!enabled, (el) => el.text_color(t.dim).opacity(0.5))
      .child(label);
    const zoomBar = h_flex().flex_none().gap(2).items_center().p(1).rounded(6).border(1).border_color(t.border)
      .child(zoomBtn("zoom-out", "−", "Zoom out", z > ZOOMS[0] + 0.001, () => this.setZoom([...ZOOMS].reverse().find((v) => v < z - 0.001) ?? ZOOMS[0])))
      .child(zoomBtn("zoom-reset", `${Math.round(z * 100)}%`, "Back to 100%", Math.abs(z - 1) > 0.001, () => this.setZoom(1)))
      .child(zoomBtn("zoom-in", "+", "Zoom in", z < MAX - 0.001, () => this.setZoom(ZOOMS.find((v) => v > z + 0.001) ?? MAX)))
      .child(zoomBtn("zoom-fit", "Fit", "Fit the image to the pane", fit != null && !this.fitMode, () => { this.fitMode = true; this.pan = { x: 0, y: 0 }; }));
    const header = h_flex().h(30).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border).text_size(11)
      .child(div().flex_1().min_w(0).truncate().child(`${Math.round(w)} × ${Math.round(h)}${this.svg ? " · SVG" : ""}`))
      .child(zoomBar);

    // The viewport: the image moved by this.pan (a drag or the wheel), centered when smaller.
    const a = this.area, vw = a?.width ?? 0, vh = a?.height ?? 0, cw = w * z, ch = h * z;
    const clamp = (p) => ({ x: Math.max(0, Math.min(p.x, cw - vw)), y: Math.max(0, Math.min(p.y, ch - vh)) });
    this.pan = clamp(this.pan);
    const left = cw < vw ? (vw - cw) / 2 : -this.pan.x, top = ch < vh ? (vh - ch) / 2 : -this.pan.y;
    const movable = cw > vw + 1 || ch > vh + 1;
    const bar = (vertical, len, view, at) => {
      if (len <= view + 1 || !view) return null;
      const size = Math.max(24, (view * view) / len), off = (at / (len - view)) * (view - size - 8);
      return vertical
        ? div().absolute().right(2).top(4 + off).w(4).h(size).rounded(2).bg(t.input)
        : div().absolute().bottom(2).left(4 + off).h(4).w(size).rounded(2).bg(t.input);
    };
    const view = div().id("image-view").flex_1().min_h(0).relative().overflow_hidden()
      .when(movable, (el) => (this.drag?.moved ? el.cursor_grabbing() : el.cursor_grab()))
      .on_size_change((size, cx) => {
        const next = { width: Math.round(size.width), height: Math.round(size.height) };
        if (next.width !== this.area?.width || next.height !== this.area?.height) { this.area = next; cx.notify(); }
      })
      .on_scroll_wheel((e, cx) => {
        if (e.modifiers.control || e.modifiers.platform) {
          const dy = e.delta.y || e.delta.x;
          if (!dy) return;
          this.setZoom(this.current() * Math.pow(1.0015, dy), e.local_position);
          return cx.notify();
        }
        const sideways = e.modifiers.shift && !e.delta.x;
        const dx = sideways ? e.delta.y : e.delta.x, dy = sideways ? 0 : e.delta.y;
        const next = clamp({ x: this.pan.x - dx, y: this.pan.y - dy });
        if (next.x !== this.pan.x || next.y !== this.pan.y) { this.pan = next; cx.notify(); }
      })
      .on_mouse_down("left", (e) => { this.drag = { x: e.position.x, y: e.position.y, pan: { ...this.pan }, moved: false }; })
      .on_mouse_move((e, cx) => {
        const d = this.drag;
        if (!d) return;
        const dx = e.position.x - d.x, dy = e.position.y - d.y;
        if (!d.moved && Math.hypot(dx, dy) < 4) return;
        d.moved = true;
        this.pan = clamp({ x: d.pan.x - dx, y: d.pan.y - dy });
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => { if (this.drag) { this.drag = null; cx.notify(); } })
      .on_hover((hov, cx) => { if (!hov && this.drag) { this.drag = null; cx.notify(); } })
      .when(Boolean(this.src), (el) => el.child(image(this.src).absolute().left(left).top(top).w(cw).h(ch)))
      .when(!this.src, (el) => el.child(div().p(16).child(this.error || "Loading…")))
      .children([bar(true, ch, vh, this.pan.y), bar(false, cw, vw, this.pan.x)].filter(Boolean));
    return root.child(header).child(view);
  }
}
