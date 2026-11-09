// Writes a prompt about a Jira issue into a coding agent's session, without sending it.
// Any agent Herdr knows works: one already on screen, or a new tab running one of
// `knownAgents()` (programs.json entries with `run`, installed on this machine).
//
// Neither hc nor Herdr can type text without pressing Enter (`hc send` always submits,
// `hc keys` only takes named keys, no accents), so the prompt goes through the clipboard:
// focus the terminal, `terminal.paste`, then put the previous clipboard text back.
// Agents' input boxes take a paste without submitting it. The clipboard is GPUI's
// (`cx.read_from_clipboard` / `cx.write_to_clipboard`): Windows, Linux and macOS alike.
import { agents, panes, spaces, focused, run, notify, knownAgents } from "herdr";

// The three actions offered on an issue. Prompts stay on one line: a newline in a paste
// is fine for most agents, but one line keeps it a plain editable draft.
export const ACTIONS = [
  {
    id: "implement", label: "Implement",
    prompt: i => `Implémente la tâche Jira ${i.key} « ${i.summary} » (${i.url}). Travaille dans une nouvelle feature-branch nommée d'après la clé (feature/${i.key.toLowerCase()}-<sujet-court>).`,
  },
  {
    id: "plan", label: "Plan",
    prompt: i => `Crée un plan d'implémentation pour la tâche Jira ${i.key} « ${i.summary} » (${i.url}). Explore le code concerné, puis propose le plan sans modifier de fichiers.`,
  },
  {
    id: "chat", label: "Chat",
    prompt: i => `Je veux discuter de la tâche Jira ${i.key} « ${i.summary} » (${i.url}). Résume-la brièvement, puis attends mes questions.`,
  },
];

// Used for a new tab until knownAgents() has answered, or when it lists none installed.
export const FALLBACK_AGENT = { key: "claude", name: "Claude Code", icon: "icons/claude.svg", tint: false, run: ["claude"] };

// The agents installed here, most picked first (Herdr's order). The first is the default for a new tab.
export async function installedAgents() {
  const list = await knownAgents();
  return list.filter(a => a.installed && a.run?.length);
}

// The agent sessions on screen now, where a prompt can go: the panes of the shown tab,
// or only its zoomed pane when one is zoomed. Other tabs and spaces don't count.
export function visibleAgents() {
  const tab = focused()?.tab;
  if (!tab) return [];
  let shown = panes().filter(p => p.tab === tab && p.terminal);
  if (shown.some(p => p.zoomed)) shown = shown.filter(p => p.zoomed);
  const visible = new Set(shown.map(p => p.terminal));
  return agents().filter(a => visible.has(a.address))
    .sort((a, b) => a.address.localeCompare(b.address));
}

async function pasteInto(cx, terminal, text) {
  // Only text comes back afterwards: an image or files on the clipboard are replaced.
  const previous = cx.read_from_clipboard();
  cx.write_to_clipboard(text);
  run("pane.focus", { terminal });
  await cx.sleep(200);
  run("terminal.paste");
  // Give the paste time to read the clipboard before it's put back.
  await cx.sleep(600);
  if (previous !== undefined) cx.write_to_clipboard(previous);
}

// Starts `agent` in a new tab of the selected space (named after the issue) and waits until
// its input is ready: its pane shows up, then it reports a status other than working.
// Returns its terminal.
async function newAgentTab(cx, name, agent) {
  const space = spaces().find(s => s.active);
  if (!space) throw new Error("Aucun space sélectionné");
  const before = new Set(panes().map(p => p.terminal).filter(Boolean));
  run("tab.new", { space: space.id, name, argv: agent.run });
  let terminal = null;
  for (let waited = 0; !terminal && waited < 20000; waited += 250) {
    await cx.sleep(250);
    const tabs = new Set((spaces().find(s => s.id === space.id)?.tabs ?? []).map(t => t.id));
    terminal = panes().find(p => p.terminal && !before.has(p.terminal) && tabs.has(p.tab))?.terminal ?? null;
  }
  if (!terminal) throw new Error(`Le nouvel onglet ${agent.name} n'est pas apparu`);
  for (let waited = 0; waited < 30000; waited += 250) {
    const a = agents().find(a => a.address === terminal);
    if (a && a.status !== "working") break;
    await cx.sleep(250);
  }
  await cx.sleep(800); // the input box draws a moment after the first status
  return terminal;
}

// target: { terminal } for a session on screen, or { agent } (a knownAgents() entry) for a new tab.
export async function writePrompt(cx, issue, action, target) {
  try {
    const terminal = target.terminal ?? await newAgentTab(cx, issue.key, target.agent);
    await pasteInto(cx, terminal, action.prompt(issue));
  } catch (e) {
    notify({ title: `${action.label} : ${issue.key}`, body: String(e?.message ?? e), level: "error" });
  }
}
