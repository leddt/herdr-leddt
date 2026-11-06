# herdr-leddt

My customizations to the [Herdr app](https://gpui-kit.com): a layout and a set of mods, all under the `leddt` name.
They're built on Herdr 0.1.13. The layout and four of the mods are clones of shipped ones, and the other three are new.

Edit them in `~/.config/herdr-app` (live reload works there), then run `./sync.sh` to copy them here.

## Layout: `layouts/leddt.json`

A clone of the shipped `main` layout. Its structure, sizes and look are unchanged. The only differences are:

| Block | `main` | `leddt` |
|---|---|---|
| Sidebar agents list (`agents`) | `agents` | `leddt-agents` |
| Sidebar, below the lists | — | **new** `leddt-usage` block (64px) |
| Tab bar (`tabs`) | `tabs` | `leddt-tabs` |
| Pane header | `pane` | `leddt-pane` |
| Right panel, Files (`files`) | `files` | `leddt-files` |

Everything else (`workspace-chrome`, `spaces`, `changes`, `workspace-status`) is still the shipped mod.

## Cloned mods

### `leddt-agents` (from `agents`)

- **Two-line rows** (42px instead of 30px). The first line is the space name, plus the tab name only when someone named the tab. The second line is always the agent's own name, which for Claude is its session name. The shipped heuristics that guess a label from the tab or terminal title are gone.
- **Rename a Claude session:** double-click a Claude row to open a dialog that sends `/rename <name>` to the session.
- **Done button** (✓, on hover, Claude rows only): sends `/clear`, which archives the session (you can get it back with `/resume`) and starts a fresh one in place.
- The sort menu popup opens from `leddt-agents`.

### `leddt-pane` (from `pane`)

These only show for panes running Claude Code:

- **Context chip** at the right edge of the header: a small bar with the context % (it changes colour at 65% and again at 85%). It refreshes every 5s and is shared as `leddt-context:<terminal>`. Click it to open the `leddt-context` popover. It only appears on local machines.
- **Done button** (✓, on hover): sends `/clear`, the same as in `leddt-agents`.
- **Open in Claude Desktop** (on hover, local only): finds the session ID from `~/.claude/sessions/<pid>.json` (it walks child processes, because Claude often runs under a shell wrapper) and opens `claude://resume?session=<id>`.
- `context.js` (new) reads context usage from the session transcript.

### `leddt-tabs` (from `tabs`)

- **"New Claude Split" button** after the tabs. It opens the `leddt-split` dialog.

### `leddt-files` (from `files`)

- **"Open in Zed" button** in the header. It opens the folder you're viewing (or its git repo root, if it's inside one) with `zeditor`.

The icon paths in all four clones point at their own folder instead of the shipped mod's.

## New mods

### `leddt-usage`

A sidebar block with two bars showing Claude plan usage: **Session (5h)** and **Weekly**, each with the time until it resets. It reads the OAuth token from `~/.claude/.credentials.json`, calls `api.anthropic.com/api/oauth/usage`, and refreshes every 2 minutes.

### `leddt-context`

The popover that opens from the context chip in `leddt-pane`. It has two modes, and it remembers which one you used last (`leddt-context.mode`):

- **Simple:** the latest usage from the transcript: total, window, and what the last step added.
- **Detailed:** runs Claude Code's own `/context` on a forked, unsaved copy of the session (no API call, about 1s) and shows the breakdown by category.

### `leddt-split`

A dialog that asks for a tab name, then opens a new tab running Claude with a shell split to its right. Both start in the space's current folder. Press Enter to create the tab or Esc to cancel.
