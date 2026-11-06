// Context usage of a Claude Code session, read from its transcript
// (~/.claude/projects/<folder>/<sessionId>.jsonl): the last main-thread
// assistant message's usage is what the model saw on its last turn.
import { exec } from "herdr";

// Context window by model id. Claude Code's transcript doesn't record it, so
// it's guessed: 5.x models run with 1M here; anything past 200k is 1M too.
export function contextWindow(model, total) {
  if (/\[1m\]/i.test(model ?? "") || /-5(-\d+)?$/.test(model ?? "") || total > 200_000) return 1_000_000;
  return 200_000;
}

// Newest line first; stop at the last assistant turn or compaction boundary.
// tac + grep keeps large transcripts (MBs) off the UI thread and out of JS.
const SCRIPT = `
f=$(ls -t "$HOME"/.claude/projects/*/"$1".jsonl 2>/dev/null | head -n1)
[ -n "$f" ] || exit 3
t=$(tac "$f" | grep -m1 '"type":"ai-title"')
l=$(tac "$f" | grep -v '"model":"<synthetic>"' | grep -m1 -E '^\\{"parentUuid":[^,]*,"isSidechain":false,"message":\\{"model"|"isSidechain":false,"type":"system","subtype":"compact_boundary"')
printf '%s\\n%s\\n' "$t" "$l"
`;

export async function readContext(sessionId) {
  const r = await exec("sh", ["-c", SCRIPT, "sh", sessionId]);
  if (r.code !== 0) return null;
  const [titleLine, line] = r.stdout.split("\n");
  let title = null;
  try { title = JSON.parse(titleLine).aiTitle ?? null; } catch {}
  let d;
  try { d = JSON.parse(line); } catch { return null; }
  if (d.subtype === "compact_boundary") {
    const m = d.compactMetadata ?? {};
    const total = m.postTokens ?? 0;
    return { sessionId, title, model: null, total, window: contextWindow(null, m.preTokens ?? 0),
      input: null, cacheRead: null, cacheWrite: null, output: null,
      compacted: { pre: m.preTokens ?? null, trigger: m.trigger ?? null }, at: d.timestamp ?? null, cwd: d.cwd ?? null };
  }
  const u = d.message?.usage;
  if (!u) return null;
  const input = u.input_tokens ?? 0, cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0, output = u.output_tokens ?? 0;
  const total = input + cacheRead + cacheWrite + output;
  const model = d.message.model ?? null;
  return { sessionId, title, model, total, window: contextWindow(model, total),
    input, cacheRead, cacheWrite, output, compacted: null, at: d.timestamp ?? null, cwd: d.cwd ?? null };
}

export function contextColor(t, pct) {
  return pct >= 85 ? t.blocked : pct >= 65 ? t.done : t.accent;
}

export function fmtTokens(n) {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 2 : 0).replace(/\.?0+$/, "")}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return String(n);
}
