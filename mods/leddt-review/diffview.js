// The Findings pane's diff view: each file with findings, as `git diff <base>`
// with the whole file for context, cut down to the lines around each finding.
import * as fs from "fs/promises";
import { exec, window } from "herdr";

// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie).
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
// Lines shown before and after a finding's line.
export const AROUND = 5;
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
  const r = await exec("git", [...READ, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "-U100000000", s.base.sha, "--", path], { cwd: s.repo, timeout: 30000 });
  if (r.code !== 0) return { error: (r.stderr || "git diff failed").trim() };
  const lines = r.stdout.replace(/\n$/, "").split("\n");
  const first = lines.findIndex((l) => l.startsWith("@@"));
  if (first >= 0) return { rows: parse(lines.slice(first)) };
  if (/^Binary files /m.test(r.stdout)) return { error: "Binary file" };
  // Unchanged since the base, or untracked: the file as it is.
  let text;
  try { text = await fs.readFile(`${s.repo}/${path}`, "utf8"); } catch { return { error: "File not found" }; }
  if (text.includes("\0")) return { error: "Binary file" };
  const tracked = await exec("git", [...READ, "ls-files", "--error-unmatch", "--", path], { cwd: s.repo }).catch(() => null);
  const kind = tracked?.code === 0 ? " " : "+";
  return { rows: text.replace(/\n$/, "").split("\n").map((t, i) => ({ kind, number: i + 1, text: clip(t) })) };
}

// { general: findings with no file, files: [{ path, error, rows, at: Map(row index → findings),
//   loose: findings with no line (or one that isn't there), spans: [{ lo, hi }] row ranges to show }] }
export async function loadDiff(s, findings) {
  const general = [], byFile = new Map();
  for (const f of findings) {
    if (!f.file) { general.push(f); continue; }
    const path = relPath(s.repo, f.file);
    if (!byFile.has(path)) byFile.set(path, []);
    byFile.get(path).push(f);
  }
  const files = [];
  for (const [path, list] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) {
    const got = await fileRows(s, path).catch((e) => ({ error: String(e?.message ?? e) }));
    const rows = got.rows ?? [];
    const index = new Map();
    rows.forEach((r, i) => { if (r.kind !== "-") index.set(r.number, i); });
    const at = new Map(), loose = [];
    for (const f of [...list].sort((a, b) => (Number(a.line) || 0) - (Number(b.line) || 0))) {
      const i = index.get(Number(f.line));
      if (i === undefined) loose.push(f);
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
    files.push({ path, error: got.error ?? null, rows, at, loose, spans });
  }
  return { general, files };
}
