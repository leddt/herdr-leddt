# herdr-leddt

My customizations to the [Herdr app](https://gpui-kit.com): a layout, a set of mods and a light theme, all under the `leddt` name.
They're built on Herdr 0.1.13. The layout and five of the mods are clones of shipped ones, and the other four mods and the theme are new.

Edit them in `~/.config/herdr-app`, or `$HERDR_APP_HOME` when it's set (live reload works there), then run `./sync.sh` to copy them here. The script needs `rsync`, which Git Bash on Windows doesn't include.

## Layout: `layouts/leddt.json`

A clone of the shipped `main` layout. Its structure, sizes and look are unchanged. The only differences are:

| Block | `main` | `leddt` |
|---|---|---|
| Sidebar spaces list (`spaces`) | `spaces` | `leddt-spaces` |
| Sidebar agents list (`agents`) | `agents` | `leddt-agents` |
| Sidebar, below the lists | — | **new** `leddt-usage` block (64px) |
| Tab bar (`tabs`) | `tabs` | `leddt-tabs` |
| Pane header | `pane` | `leddt-pane` |
| Right panel, Files (`files`) | `files` | `leddt-files` |
| Right panel, Jira (`jira`) | — | **new** `leddt-jira` block in the `panel-body` stack |

Everything else (`workspace-chrome`, `changes`, `workspace-status`) is still the shipped mod.

## Cloned mods

### `leddt-spaces` (from `spaces`)

- **Two-line rows** (42px instead of 30px). The first line is the space name. The second line is the current branch of the space's first terminal, or the repo name when HEAD is detached, or the folder when it isn't a repo. Ahead/behind stays at the right of the second line.
- **Pull request number** at the right of the first line, when the branch has an open PR. Click it to open the PR in the browser. Drafts are dimmed. The provider comes from the `origin` URL: GitHub uses `gh pr list`, and Azure DevOps (`dev.azure.com`, `*.visualstudio.com`, SSH or HTTPS) uses `az repos pr list`, which needs the `azure-devops` extension. The lookup runs whenever the shipped mod refreshes git (at most every 30s per branch), one at a time and apart from git, because `az` takes several seconds.

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
- **"Jira" panel button** next to Files and Changes. It's always shown (it isn't one of the welcome screen's `workspace.panels`), and it's remembered per space like the others.

### `leddt-files` (from `files`)

- **"Open in Zed" button** in the header. It opens the folder you're viewing (or its git repo root, if it's inside one) with `zeditor`, or `zed` when `zeditor` isn't installed (Windows, macOS).

The icon paths in the four clones that have their own icons point at their own folder instead of the shipped mod's.

## New mods

### `leddt-usage`

A sidebar block with two bars showing Claude plan usage: **Session (5h)** and **Weekly**, each with the time until it resets. It reads the OAuth token from `~/.claude/.credentials.json`, calls `api.anthropic.com/api/oauth/usage`, and refreshes every 2 minutes.

### `leddt-context`

The popover that opens from the context chip in `leddt-pane`. It has two modes, and it remembers which one you used last (`leddt-context.mode`):

- **Simple:** the latest usage from the transcript: total, window, and what the last step added.
- **Detailed:** runs Claude Code's own `/context` on a forked, unsaved copy of the session (no API call, about 1s) and shows the breakdown by category.

### `leddt-jira`

A right-panel block that lists the Jira issues assigned to you that aren't done (`assignee = currentUser() AND statusCategory != Done`). Open it with the **Jira** button in the tab bar.

- **Grouping:** by project (sorted by name), then by status inside each project, in the status bar's order. Issues within a status are sorted by last update. Projects and status sub-groups fold on click.
- **Rows:** the summary, then the issue type as a small outlined tag and the key; the tooltip adds the status. Click a row to open the issue in the browser. The tag is tinted by type name, in English or French: bug red, epic magenta, story green, sub-task cyan, task accent, anything else neutral.
- **Filter bars** under the header: **Statut** (a chip per status in the results) and **Type** (a chip per issue type, by name, with its tag colour). Click a chip to show or hide those issues; hidden chips are dimmed. A chip's count is what it would show given the other bar's filter. The header shows `shown / total`.
- **Status order:** drag a status chip (press on one, release on another) and it takes that one's place. The dragged chip fades, a ghost copy follows the pointer once it has moved a few px, and the target is outlined; releasing elsewhere or leaving the panel cancels. The order also orders the sub-groups in every project. By default, and for statuses it doesn't know yet (they go after), it's in-progress first (yellow dot), then to-do, then by name.
- **Reset filters:** a link in the header, shown when something is hidden or the order was changed. It shows every status and type again and goes back to the automatic order. Folds are kept.
- **Remembered:** hidden statuses and types (by name, across projects), the status order and the folds, in the mod's `localStorage` (`<Herdr home>/data/leddt-jira/store.json`). One set for the whole window, not per space, and not in this repo.
- **Data:** runs the `twg` CLI (`twg jira workitem query --jql ... -o json`), so it uses twg's own sign-in and site and holds no token. `twg` has to be on the PATH and signed in. It reads up to 5 pages of 100 issues; each call takes about 2s. It refreshes when the panel loads, every 2 minutes (even while the panel is hidden), and with ↻ in the header. If twg fails, its first error line shows under the header.

### `leddt-split`

A dialog that asks for a tab name, then opens a new tab running Claude with a shell split to its right. Both start in the space's current folder. Press Enter to create the tab or Esc to cancel.

## Theme: `themes/leddt-solarized-light.json`

A light theme built from the [Solarized](https://ethanschoonover.com/solarized/) Light palette. The terminal uses `base3` as its background, and the sidebars and bars use `base2`. The accent is blue. Status colours: working is yellow, blocked is red, done is green. Changes from the original scheme, all for readability: body text is `base01` instead of `base00`. Every ANSI hue is darkened (same hue, scaled toward black) to at least 4.5:1 against the background; the originals were as low as 2.9:1 for yellow, cyan and green. The bright ANSI colours keep their hues instead of turning into greys. ANSI white is `base1`, so "white" text stays visible, and the selection is a bit darker than `base2`. Pick it from the theme menu.
