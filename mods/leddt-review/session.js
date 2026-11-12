// A review session: its folder, its state file, the git range it reviews,
// and the messages sent to the two agents.
//
// ~/.config/herdr-app/data/leddt-review-sessions/<id>/
//   state.json              written only by the Findings pane (and once by the picker)
//   findings-r<round>.json  written by the reviewer
//   triage-<n>.json         written by the original agent
//   fix-<n>.json            written by the original agent
//   verify-<n>.json         written by the reviewer
import * as fs from "fs/promises";
import { appHome, exec } from "herdr";

// While a request is out, its findings show this state; Dismiss puts them back.
export const BUSY_BACK = { Triaging: "New", Fixing: "Triaged", Verifying: "Fixed" };

export const sessionsDir = () => `${appHome()}/data/leddt-review-sessions`;
export const sessionDir = (id) => `${sessionsDir()}/${id}`;
export const statePath = (id) => `${sessionDir(id)}/state.json`;
// Done sessions move here, out of the Review button's sight.
export const archiveDir = (id) => `${appHome()}/data/leddt-review-archive/${id}`;
// Shared {sessionId: pane} of the Findings panes (pane mods aren't told their pane).
export const PANES = "leddt-review.panes";

export async function loadState(id) {
  try { return JSON.parse(await fs.readFile(statePath(id), "utf8")); } catch { return null; }
}

export async function saveState(s) {
  await fs.mkdir(sessionDir(s.id), { recursive: true });
  await fs.writeFile(statePath(s.id), JSON.stringify(s, null, 2));
}

export async function readJson(path) {
  if (!(await fs.exists(path))) return { missing: true };
  let text;
  // Gone or swapped between the two calls: an error, which only counts once the agent's turn is over.
  try { text = await fs.readFile(path, "utf8"); } catch (e) { return { error: `Couldn't read ${path.split("/").pop()}: ${e?.message ?? e}` }; }
  try { return { data: JSON.parse(text) }; } catch (e) { return { error: `Invalid JSON in ${path.split("/").pop()}: ${e?.message ?? e}` }; }
}

// --- git: where to review from -------------------------------------------------

const TRUNKS = ["main", "master", "develop", "trunk"];

// Every local branch the current one could have come from, nearest first: how
// many of HEAD's commits each one lacks, all from one for-each-ref
// (%(ahead-behind), git 2.41+). A process per branch took ~0.2s each on
// Windows, a minute in a repo with a few hundred branches. A branch that lacks
// none of them (the same commit, or one built on top) can't be a base.
const CANDIDATES = `
head=$(git rev-parse HEAD) || exit 2
cur=$(git symbolic-ref --short -q HEAD)
printf '%s\\t%s\\t%s\\n' "$(git rev-parse --show-toplevel)" "$cur" "$head"
git for-each-ref --format='%(refname:short)	%(refname)	%(ahead-behind:HEAD)' refs/heads |
while IFS='	' read -r name full ab; do
  [ "$name" = "$cur" ] && continue
  n=\${ab#* }
  [ "$n" = 0 ] && continue
  printf '%s\\t%s\\t%s\\n' "$name" "$full" "$n"
done
`;

// The merge-base of each shown branch, in one shell.
const MERGE_BASES = `for ref; do printf '%s\\n' "$(git merge-base HEAD "$ref" 2>/dev/null)"; done`;

export async function baseCandidates(cwd) {
  const r = await exec("sh", ["-c", CANDIDATES], { cwd, timeout: 60000 });
  if (r.code !== 0) throw new Error((r.stderr || "Not a git repository").trim());
  const [first, ...lines] = r.stdout.split("\n").filter(Boolean);
  const [repo, branch, head] = first.split("\t");
  const rows = lines.map((line) => {
    const [name, full, n] = line.split("\t");
    return { name, key: name, full, ahead: Number(n), remote: false };
  }).sort((a, b) => a.ahead - b.ahead || a.name.localeCompare(b.name));
  // Down to the trunk: anything further is older than main.
  const trunk = rows.findIndex((row) => TRUNKS.includes(row.key));
  const shown = (trunk >= 0 ? rows.slice(0, trunk + 1) : rows).slice(0, 25);
  const mb = await exec("sh", ["-c", MERGE_BASES, "sh", ...shown.map((row) => row.full)], { cwd, timeout: 60000 });
  const bases = mb.stdout.split("\n");
  const candidates = shown
    .map(({ full, ...row }, i) => ({ ...row, mergeBase: (bases[i] ?? "").trim() }))
    .filter((row) => row.mergeBase);
  return { repo, branch: branch || null, head, candidates };
}

// A ref someone typed: its merge-base with HEAD.
export async function resolveBase(cwd, ref) {
  // --end-of-options: a typed "-h" or "--all" is a (bad) ref, not a flag.
  const mb = await exec("git", ["merge-base", "--end-of-options", "HEAD", ref], { cwd });
  if (mb.code !== 0) throw new Error((mb.stderr || `Unknown ref: ${ref}`).trim());
  const mergeBase = mb.stdout.trim();
  const n = await exec("git", ["rev-list", "--count", `${mergeBase}..HEAD`], { cwd });
  return { name: ref, key: ref, mergeBase, ahead: Number(n.stdout.trim()) || 0, remote: false };
}

// --- messages ------------------------------------------------------------------

const short = (sha) => sha.slice(0, 10);

export function reviewTask(s) {
  return `/code-review the changes on this branch${s.branch ? ` (${s.branch})` : ""} since it diverged from ${s.base.name}: ` +
    `exactly \`git diff ${s.base.sha}\` (commits ${short(s.base.sha)}..HEAD plus uncommitted changes). Don't review anything outside that range.`;
}

export function reportTask(s, round, file) {
  return [
    `Write every finding from the review you just did (round ${round}) to this file as JSON, with your Write tool:`,
    file,
    "",
    `Shape: {"findings":[{"id":"R${round}-1","title":"one line","file":"path/from/repo/root","line":42,"severity":"low|medium|high","description":"what's wrong and why","failure":"concrete scenario that breaks"}]}`,
    `Number ids R${round}-1, R${round}-2, ... in order. ${round > 1 ? 'If a finding is the same issue as one from an earlier round, add "repeats":"<its earlier id>". ' : ""}` +
    'If there are no findings, write {"findings":[]}. Write only that file; don\'t change any code.',
  ].join("\n");
}

const brief = (f) => ({
  id: f.id, title: f.title, file: f.file, line: f.line, severity: f.severity, description: f.description, failure: f.failure,
  // A follow-up: raised while verifying the fix of that finding.
  ...(f.parent ? { follow_up_of: f.parent } : {}),
});

// What follow_up_of means, for a prompt whose findings carry it.
const followUpNote = (findings) => findings.some((f) => f.parent) ? [
  'A finding with "follow_up_of" is a new point the reviewer raised while verifying the fix of that finding. ' +
  "It is separate from its parent: not a duplicate of it, and not settled by the parent's fix.",
] : [];

export function triageTask(s, findings, file) {
  return [
    `A separate code reviewer (terminal ${s.reviewer}) reviewed this branch's changes since ${s.base.name} (\`git diff ${short(s.base.sha)}\`). ` +
    "Triage each finding below against the actual code. Don't change any code in this step.",
    ...followUpNote(findings),
    "",
    "Write your triage to this file as JSON, with your Write tool, one entry per finding id:",
    file,
    "",
    'Shape: {"triage":[{"id":"R1-1","status":"Valid|Invalid|Partial","impact":"Trivial|Minor|Major|Critical","recommendation":"short action, e.g. Fix now, Open an issue, Ask the designer, Ignore","reason":"why, in a sentence or two"}]}',
    "",
    "Findings:",
    JSON.stringify(findings.map(brief)),
  ].join("\n");
}

// The person's instruction for a finding, from the Findings pane.
const withInstruction = (value) => (value ? { instruction: value } : {});

export function fixTask(s, findings, file) {
  const any = findings.some((f) => f.instruction);
  return [
    "Fix these code review findings (you triaged them earlier; your triage is included).",
    ...(any ? [
      'A finding with an "instruction" comes with the person\'s direction for it: do what it says, which takes precedence over ' +
      'your triage and over a code fix (e.g. "Create a Jira issue" means create the issue, not change the code). ' +
      'Report "fixed": true once you\'ve done what it asks, and say what you did in "note". Handle the others as usual.',
    ] : []),
    ...followUpNote(findings),
    "",
    "When you're done, write the outcome to this file as JSON, with your Write tool, one entry per id:",
    file,
    "",
    'Shape: {"fixed":[{"id":"R1-1","fixed":true,"note":"what you changed, or why you didn\'t"}]}',
    "",
    "Findings:",
    JSON.stringify(findings.map((f) => ({ ...brief(f), triage: f.triage, ...withInstruction(f.instruction) }))),
  ].join("\n");
}

export function verifyTask(s, findings, file) {
  const any = findings.some((f) => f.fix?.instruction);
  return [
    "The author says these findings from your review are now fixed. Check each one against the current code " +
    "(including uncommitted changes). Don't change any code.",
    ...(any ? [
      'A finding with an "instruction" was handled the way the person asked instead of (or as well as) a code fix: ' +
      'verify that the instruction was followed, from the fix note and the code, not that the code changed.',
    ] : []),
    ...followUpNote(findings),
    "",
    "Write the result to this file as JSON, with your Write tool, one entry per id:",
    file,
    "",
    'Shape: {"verify":[{"id":"R1-1","verified":true,"note":"what you checked; if not fixed, what\'s still wrong"}]}',
    "",
    "If checking a fix turns up new problems that are not the original finding (the fix holds but raises another point, or brings in a new issue), " +
    'add them to that entry as "follow_ups": [{"title":"one line","file":"path/from/repo/root","line":42,"severity":"low|medium|high","description":"what\'s wrong and why","failure":"concrete scenario that breaks"}]. ' +
    "Don't give them ids (they're numbered after their finding: R1-2.1, R1-2.2, ...), and leave follow_ups out when there are none. " +
    "What's still wrong with the original finding goes in the note, not in follow_ups. " +
    'A finding with "existing_follow_ups" already has those: don\'t report them again, only points that are new.',
    "",
    "Findings:",
    JSON.stringify(findings.map((f) => {
      // Its follow-ups so far, so a second verify doesn't raise them again under new numbers.
      const existing = s.findings.filter((c) => c.parent === f.id).map((c) => ({ id: c.id, title: c.title }));
      return { ...brief(f), fix_note: f.fix?.note ?? null, ...withInstruction(f.fix?.instruction), ...(existing.length ? { existing_follow_ups: existing } : {}) };
    })),
  ].join("\n");
}

export function loopTask(s) {
  return reviewTask(s) + " This is a new round: review the code as it is now.";
}
