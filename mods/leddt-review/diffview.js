// The Findings pane's diff view: each file with findings, as `git diff <base>`
// with the whole file for context, cut down to the lines around each finding.
import { exec, window, readTextFile } from "herdr";

// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie),
// and a path is a path, not a pattern (`app/[id]/page.tsx`).
const READ = ["--literal-pathspecs", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
// Lines shown before and after a finding's line.
export const AROUND = 5;
// Bigger files aren't shown (as in leddt-changes): their findings stay on the file.
const MAX_BYTES = 400000;
const clip = (text) => (text.length > 2000 ? text.slice(0, 2000) + "… (line truncated)" : text) || " ";

// A finding's file, relative to the repo root (an agent may give it absolute).
export function relPath(repo, file) {
  const norm = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "");
  const f = norm(file), root = norm(repo);
  const win = window()?.platform === "windows";
  const head = f.slice(0, root.length + 1);
  if (win ? head.toLowerCase() === (root + "/").toLowerCase() : head === root + "/") return f.slice(root.length + 1);
  return f.replace(/^\.\//, "");
}

// The file's text, or why there's none to show. (fs/promises only reads under
// the home folder; readTextFile reads anywhere, up to 1 MiB, and throws past it.)
async function readSmall(path) {
  let text;
  try { text = await readTextFile(path); } catch { return { error: "File too large to show" }; }
  if (text === null) return { error: "File not found", missing: true };
  if (text.length > MAX_BYTES) return { error: `File too large to show (${Math.round(text.length / 1000)} KB)` };
  return text.includes("\0") ? { error: "Binary file" } : { text };
}

// Diff lines → rows: " ", "+" (new numbering) or "-" (old numbering).
function parse(lines) {
  let old = 0, next = 0;
  const rows = [];
  for (const line of lines) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (m) { old = +m[1]; next = +m[2]; continue; }
    const kind = line[0];
    if (kind === "-") rows.push({ kind, number: old++, text: clip(line.slice(1)) });
    else if (kind === "+") rows.push({ kind, number: next++, text: clip(line.slice(1)) });
    else if (kind === " ") { old++; rows.push({ kind, number: next++, text: clip(line.slice(1)) }); }
  }
  return rows;
}

// Every line of the file, marked against the review's base.
async function fileRows(s, path) {
  // Its size first: a large file is neither diffed nor parsed. A deleted one
  // (missing) still has a diff: the base's text, all removed.
  const got = await readSmall(`${s.repo}/${path}`);
  if (got.error && !got.missing) return got;
  const r = await exec("git", [...READ, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "-U100000000", s.base.sha, "--", path], { cwd: s.repo, timeout: 30000 });
  if (r.code !== 0) return { error: (r.stderr || "git diff failed").trim() };
  const lines = r.stdout.replace(/\n$/, "").split("\n");
  const first = lines.findIndex((l) => l.startsWith("@@"));
  if (first >= 0) return { rows: parse(lines.slice(first)) };
  if (/^Binary files /m.test(r.stdout)) return { error: "Binary file" };
  // Unchanged since the base, or untracked: the file as it is.
  if (got.error) return got;
  const tracked = await exec("git", [...READ, "ls-files", "--error-unmatch", "--", path], { cwd: s.repo }).catch(() => null);
  const kind = tracked?.code === 0 ? " " : "+";
  return { rows: got.text.replace(/\n$/, "").split("\n").map((t, i) => ({ kind, number: i + 1, text: clip(t) })) };
}

// Remembers the text of each finding's line as the reviewer saw it, so the diff
// view can find the line again once the code above it has moved.
export async function captureAnchors(s, findings) {
  const texts = new Map();
  for (const f of findings) {
    if (!f.file || !(Number(f.line) > 0) || f.anchor !== undefined) continue;
    const path = relPath(s.repo, f.file);
    if (!texts.has(path)) texts.set(path, readSmall(`${s.repo}/${path}`));
    const got = await texts.get(path);
    const text = got.text?.split("\n")[Number(f.line) - 1];
    f.anchor = text === undefined ? null : text.replace(/\r$/, "").trim();
  }
}

// Where a finding's line is now: its line if the text there is still the one
// the reviewer saw, else the nearest line with that text. null: it's gone
// (changed, or the file is shorter). Without an anchor, its line as is.
function locate(f, rows, index) {
  const line = Number(f.line);
  const at = index.get(line);
  if (typeof f.anchor !== "string" || !f.anchor) return at ?? null;
  const same = (i) => rows[i].kind !== "-" && rows[i].text.trim() === f.anchor;
  if (at !== undefined && same(at)) return at;
  let best = null;
  for (let i = 0; i < rows.length; i++) if (same(i) && (best === null || Math.abs(rows[i].number - line) < Math.abs(rows[best].number - line))) best = i;
  return best;
}

// { general: findings with no file, files: [{ path, error, rows, at: Map(row index → findings),
//   loose: findings with no line (or one that's gone), stale: ids whose line is gone,
//   spans: [{ lo, hi }] row ranges to show }] }
export async function loadDiff(s, findings) {
  const general = [], byFile = new Map();
  for (const f of findings) {
    if (!f.file) { general.push(f); continue; }
    const path = relPath(s.repo, f.file);
    if (!byFile.has(path)) byFile.set(path, []);
    byFile.get(path).push(f);
  }
  const files = await Promise.all([...byFile].sort(([a], [b]) => a.localeCompare(b)).map(async ([path, list]) => {
    const got = await fileRows(s, path).catch((e) => ({ error: String(e?.message ?? e) }));
    const rows = got.rows ?? [];
    const index = new Map();
    rows.forEach((r, i) => { if (r.kind !== "-") index.set(r.number, i); });
    const at = new Map(), loose = [], stale = new Set();
    for (const f of [...list].sort((a, b) => (Number(a.line) || 0) - (Number(b.line) || 0))) {
      const i = Number(f.line) > 0 ? locate(f, rows, index) : null;
      if (i === null) { loose.push(f); if (Number(f.line) > 0 && rows.length) stale.add(f.id); }
      else { if (!at.has(i)) at.set(i, []); at.get(i).push(f); }
    }
    // A window around each finding's line, merged with the next when they touch.
    const spans = [];
    for (const i of [...at.keys()].sort((a, b) => a - b)) {
      const lo = Math.max(0, i - AROUND), hi = Math.min(rows.length - 1, i + AROUND);
      const last = spans[spans.length - 1];
      if (last && lo <= last.hi + 1) last.hi = Math.max(last.hi, hi);
      else spans.push({ lo, hi });
    }
    return { path, error: got.error ?? null, rows, at, loose, stale, spans };
  }));
  return { general, files };
}
