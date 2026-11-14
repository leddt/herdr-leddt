# herdr-leddt

My customizations to the [Herdr app](https://gpui-kit.com): a layout, a set of mods and a light theme, all under the `leddt` name.
They're up to date with Herdr 0.1.15: the cloned mods have the shipped changes from 0.1.14 and 0.1.15. The layout and seven of the mods are clones of shipped ones, and the other mods and the theme are new.

Edit them in `~/.config/herdr-app`, or `$HERDR_APP_HOME` when it's set (live reload works there), then run `./sync.sh` to copy them here. The script needs `rsync`, which Git Bash on Windows doesn't include, and `node`.

Mods kept in another repo (a private one, say) can sit in the same Herdr home and have blocks in the installed layout. `sync.sh` only copies the `leddt-*` mods, and it drops from the published layouts every block whose mod Herdr doesn't ship (`installed.json`) and this repo doesn't have, so the published layout never names them. A stack that showed a dropped block shows its first child instead.

## Layout: `layouts/leddt.json`

A clone of the shipped `main` layout. Its structure, sizes and look are unchanged. The only differences are:

| Block | `main` | `leddt` |
|---|---|---|
| Sidebar spaces list (`spaces`) | `spaces` | `leddt-spaces` |
| Sidebar agents list (`agents`) | `agents` | `leddt-agents` |
| Tab bar (`tabs`) | `tabs` | `leddt-tabs` |
| Pane header | `pane` | `leddt-pane` |
| Right panel, Files (`files`) | `files` | `leddt-files` |
| Right panel, Changes (`changes`) | `changes` | `leddt-changes` |
| Right panel, Branches (`branches`) | — | **new** `leddt-branches` block in the `panel-body` stack |
| Right panel, Jira (`jira`) | — | **new** `leddt-jira` block in the `panel-body` stack |
| Under the panes, above the status bar | — | **new** `leddt-command` block (`command`, 32px) |
| Status bar | `status` block | `status-row`: a **new** `leddt-usage` block (370px) at the left, then `workspace-status` |

Everything else (`workspace-chrome`, `workspace-status`) is still the shipped mod.

A mod pane, like `leddt-review`'s Findings, has no folder of its own. When one is focused, Files, Changes, the "New Split Tab" button and the pane header's split buttons use the folder of the first terminal in its tab instead of falling back to the space's. A mod pane can also name its own folder in the shared value `leddt.pane-folders` (`{ [pane]: folder }`), which comes before its tab's terminal. Herdr's own tab creation (the terminal and agent buttons, the ⋯ menu, shortcuts) still starts in the space's folder.

## Cloned mods

### `leddt-spaces` (from `spaces`)

- **Two-line rows** (42px instead of 30px). The first line is the space name. The second line is the current branch of the space's first terminal, or the repo name when HEAD is detached, or the folder when it isn't a repo. Ahead/behind stays at the right of the second line.
- **Pull request number** at the right of the first line, when the branch has an open PR. Click it to open the PR in the browser. Drafts are dimmed. The provider comes from the `origin` URL: GitHub uses `gh pr list`, and Azure DevOps (`dev.azure.com`, `*.visualstudio.com`, SSH or HTTPS) uses `az repos pr list`, which needs the `azure-devops` extension. The lookup runs whenever the shipped mod refreshes git (at most every 30s per branch), one at a time and apart from git, because `az` takes several seconds.
- **Project icon as the avatar.** When a space's checkout is a git repo, the mod looks through its tracked files (`git ls-files`) for an image (svg, png, ico, jpg, webp, gif, bmp) with a common icon name. The best match wins: `favicon`, then `apple-touch-icon`, sized favicons (`favicon-32x32`, `android-chrome-192x192`…), `icon` / `app-icon`, `logo` / `logo192`, and `logo-<repo>`. SVG and PNG come before ICO, and shallower files before deeper ones. It skips dot-folders and folders that hold other people's or generated files (`node_modules`, `vendor`, `App_Plugins`, `Umbraco`, tests, fixtures, examples, `bin`, `obj`, `dist`, `build`…). If nothing matches, the coloured letter stays. Herdr's `image()` only reads under its home, so the icon is copied to `<Herdr home>/data/leddt-spaces-icons/`. Spaces on another machine keep their letter.
- **Right-click → Choose icon…** opens the system file picker (PowerShell's dialog on Windows, `osascript` on macOS, `zenity` or `kdialog` on Linux) to use a specific file. **Use letter avatar** goes back to the coloured letter, and **Use project icon** goes back to automatic detection. The choice is per space, in the shared value `leddt-spaces.icons`. The menu is `leddt-menu`, and it reaches this mod through `leddt-spaces.icon-<pick|auto|letter>:<space>` commands.
- **Avatars for other mods:** each space's current avatar (the copied icon, or its letter and colour) is published in the shared value `leddt-spaces.avatars`, and written again only when it changes. `leddt-agents` reads it.

### `leddt-agents` (from `agents`)

- **Two-line rows** (42px instead of 30px). The first line is the space name, plus the tab name only when someone named the tab. The second line is always the agent's own name, which for Claude is its session name. The shipped heuristics that guess a label from the tab or terminal title are gone.
- **Space avatar with the agent's icon:** each row shows its space's avatar from `leddt-spaces` (project icon or coloured letter), with the agent's icon smaller on its bottom-right corner. Until `leddt-spaces` has published the avatar, the row shows the agent's icon alone. Sub-agent rows keep the agent's icon only.
- **Rename a Claude session:** double-click a Claude row to open a dialog that sends `/rename <name>` to the session.
- **Done button** (✓, on hover, Claude rows only): replaces the agent's pane with a fresh Claude Code in the same place and folder. It splits a new pane running `claude` off the old one, then closes the old one, which ends its Claude (the session stays on disk: get it back with `/resume`). The swap is instant; Claude takes a second or two to start. It doesn't send `/clear`: hc holds typed keys for about 3 s after a person types, and Herdr has no other way to type into a terminal.
- The sort menu popup opens from `leddt-agents`.

### `leddt-pane` (from `pane`)

- **CPU and memory** at the right of the header (before the context chip), for every terminal on this machine: the CPU % and memory of the terminal's process and all its descendants (the shell, the program it runs, that program's children). The CPU is a share of one core, averaged since the last reading, so it can go above 100%, and it's brighter from 50%; the tooltip adds the share of the whole machine and the number of processes. `stats.js` (new) reads the process table once every 5s for all headers (`Get-CimInstance Win32_Process` on Windows, about 0.4s of one core each time; `ps` elsewhere), and only while a pane's tab is on screen. The CPU shows from the second reading.

These only show for panes running Claude Code:

- **Context chip** at the right edge of the header: a small bar with the context % (it changes colour at 65% and again at 85%). It refreshes every 5s and is shared as `leddt-context:<terminal>`. Click it to open the `leddt-context` popover. It only appears on local machines.
- **Review button** (on hover, local only, needs the pane's folder): reopens this agent's latest review on the current branch: it focuses the Findings pane if it's open, or opens it again to the right. When there's none, or with Shift+click, it opens the `leddt-review` branch picker to start a new one. Everything after that is in `leddt-review`. Pane mods aren't told their own pane id, so the pane of each session is remembered in the shared value `leddt-review.panes` when it opens (`review.js`). Sessions from before that fall back to the review pane in the agent's tab.
- `context.js` (new) reads context usage from the session transcript.

The header also names a `leddt-review` pane "Review" instead of the mod's name, and any mod pane that names itself in the shared value `leddt.pane-titles` (`{ [pane]: name }`) by that name. For a mod pane, it shows the folder it names in `leddt.pane-folders`, else the folder of the first terminal in its tab, and its split buttons open the new terminal there (`terminal.open`, since `pane.split` takes no folder).

### `leddt-tabs` (from `tabs`)

- **Four new-tab buttons instead of "+"**: a terminal tab (`tab.new`, like Ctrl+Shift+T), a tab running the most used agent (the first installed one in `knownAgents()`, Claude if none; its icon shows which), "New Split Tab" (the pane header's split-right icon: an unnamed tab running that same agent with a shell split to its right, both in the space's current folder; `split.js`), and "⋯", which opens Herdr's new-tab menu. The agent list is shared with `new-menu` (`new-menu.agents`) and asked for again at most once a minute per machine.
- **Panel buttons from the layout:** after Files and Changes, one button per block of the `panel-body` stack whose props have `panel: { label, icon }` (Branches and Jira here), shown once its mod's `main.js` is found in the Herdr home (checked again every 30s while it's missing, so a mod added later gets its button). These aren't among the welcome screen's `workspace.panels`, so they're always offered, and they're remembered per space like the others.

### `leddt-files` (from `files`)

- **"Open in Zed" button** in the header. It opens the folder you're viewing (or its git repo root, if it's inside one) with `zeditor`, or `zed` when `zeditor` isn't installed (Windows, macOS).
- **Folder of a mod pane:** see the note under the layout.
- **Opens a file asked for by `leddt-changes`** (a double-click there) **or `leddt-review`** (a file name in the Findings pane's Diff view): it shows the file and opens its folders in the tree, so ← goes back to it. The request is the shared value `leddt-files.open` (`{ path, on, at }`); it's only honoured within 10s and once, since shared values persist. A file outside the folder Files is browsing (when the focused pane is below the repo root) gets a warning instead.
- **Markdown preview:** hovering a `.md` (or `.markdown`, `.mdx`) file shows an eye button, also in the header while that file is shown. It opens a `leddt-markdown` pane to the right of the focused pane of the shown tab, or focuses the one already showing that file in this tab. Shift+click opens it in a new tab instead, named after the file. The new pane is named after the file (`leddt.pane-titles`) and names the folder Files is browsing (`leddt.pane-folders`), so Files stays put when it's focused. Previews are tracked in the shared value `leddt-markdown.panes` (`{ [pane]: { file, on } }`); entries of closed panes are dropped when a new preview opens. Its `eye.svg` is in the mod's folder.

### `leddt-changes` (from `changes`)

- **Folder of a mod pane:** see the note under the layout.
- **Double-click a file** to see all of it in the Files panel (`leddt-files`), which the panel switches to. The first click still opens its diff here.
- **Tree view:** a button at the right of the header switches the file list between the flat list and a tree of folders. In the tree, folders come first, then files, both by name. A folder with only one subfolder and no files shares its row (`src/app/components`). Each folder shows its files' +/− totals; click it to fold, and a folded folder also shows how many files it holds. The view is remembered (the mod's `localStorage`); folds last until Herdr restarts. Its icons (`list`, `list-tree`, and the chevrons and folder copied from `leddt-files`) are in the mod's folder.

### `leddt-menu` (from `menu`)

- **Icon items** in a space's menu, opened only from `leddt-spaces`: **Choose icon…**, plus **Use project icon** and **Use letter avatar** when they would change something. They have their own `image.svg` icon. Tab and terminal menus still use the shipped `menu`.

The icon paths in the four clones that have their own icons point at their own folder instead of the shipped mod's.

## New mods

### `leddt-usage`

One line at the left of the status bar with two small meters showing Claude plan usage: **5h** (session) and **Week**, each with its % and the time until it resets. It reads the OAuth token from `~/.claude/.credentials.json`, calls `api.anthropic.com/api/oauth/usage`, and refreshes every 5 minutes (click it to refresh now, at most once every 30 seconds). An error replaces the meters, except a 429 (rate limit): the last values stay, and it waits for `Retry-After` or a doubling backoff (5 minutes up to 1 hour) before asking again.

### `leddt-context`

The popover that opens from the context chip in `leddt-pane`. It has two modes, and it remembers which one you used last (`leddt-context.mode`):

- **Simple:** the latest usage from the transcript: total, window, and what the last step added.
- **Detailed:** runs Claude Code's own `/context` on a forked, unsaved copy of the session (no API call, about 1s) and shows the breakdown by category.

### `leddt-branches`

A right-panel block that lists the git branches of the focused pane's repo and acts on them. Open it with the **Branches** button in the tab bar.

- **Groups:** **Local**, then one per remote, most recent commit first. Groups fold on click; remotes start folded. The folds are kept in the mod's `localStorage`.
- **Counts:** each branch shows `↑n` (commits it has that the checked-out branch lacks) and `↓n` (commits it lacks), or `=` when there are none. The checked-out branch shows its distance from its upstream instead: what Push and Pull would move. With a detached HEAD the counts compare with that commit. They all come from one `git for-each-ref` with `%(ahead-behind:HEAD)`, so git 2.41 or later; an older git lists the branches without counts.
- **Actions:** hovering a branch replaces its date and counts with icon buttons, each with a tooltip; double-click to check it out. A click selects the branch as the start of a new one.
  - **Checkout:** `git switch`. A remote branch switches to its local branch, or creates one that tracks it.
  - **Merge** into the checked-out branch (`git merge --no-edit`) and **Rebase** the checked-out branch onto it. Both ask first. A conflict is left in progress, to finish or abort in a terminal.
  - **Rename** (local branches): a box under the row, Enter to rename, Esc to cancel.
  - **Delete:** asks first, except for a local branch whose upstream is gone and that has no commit the checked-out branch lacks. A local branch goes with `git branch -d`; if it isn't fully merged, a second dialog asks before `git branch -D`. A remote branch goes with `git push <remote> --delete`.
  - A branch checked out in another worktree has a `worktree` tag (its tooltip says where) and can't be checked out or deleted.
- **Details:** a selected branch shows a panel above the new-branch box: what it tracks (with what there is to push and pull), how it compares with the checked-out branch, the worktree that holds it, its last commit (hash, subject, author, date), and the first 5 commits the checked-out branch lacks. For the checked-out branch, those are the commits not pushed to its upstream. Click the branch again or the ✕ to close it.
- **Header:** **Fetch** (`git fetch --all --prune`), **Pull** and **Push** for the checked-out branch. Push sets the upstream (`-u origin <branch>`) when there is none. Network commands get 2 minutes.
- **New branch:** the box at the bottom creates a branch and switches to it. It starts from the selected branch, else from HEAD, and gets no upstream.
- **Errors:** git's own message shows in red above the box.
- **Refresh:** when the focused folder changes, every 10 seconds, after each action, and when the repo's git folder changes (local repos only).

### `leddt-jira`

A right-panel block that lists the Jira issues assigned to you that aren't done (`assignee = currentUser() AND statusCategory != Done`). Open it with the **Jira** button in the tab bar.

- **Grouping:** by project (sorted by name), then by status inside each project, in the status bar's order. Issues within a status are sorted by last update. Projects and status sub-groups fold on click.
- **Rows:** the summary, then the issue type as a small outlined tag and the key. Click a row to open the issue in the browser. The tag is tinted by type name, in English or French: bug red, epic magenta, story green, sub-task cyan, task accent, anything else neutral.
- **Change status:** hovering a row shows a **Statut** button (the current status's dot and a chevron) at the right of its first line. It opens a list under the row of the transitions the issue's workflow allows from its status (`twg jira workitem transition --id <key>`, read-only, about 1.5s, cached until the next refresh), each with its target status's dot. Click one to apply it (`--transition-id`): the row moves to its new sub-group at once, or leaves the list for a done status, then the list refreshes. If twg refuses, the row stays where it was, the menu shows twg's error and an **Ouvrir dans Jira** link. A transition that requires fields (a resolution, a comment…) opens the issue in Jira instead.
- **Copy key:** hovering a row shows a copy icon next to its key; click it to copy the key (e.g. `LS-945`) to the clipboard. It turns into a check for 1.5s.
- **Agent buttons:** hovering a row shows **Implement**, **Plan** and **Chat** at the right of its second line. Each writes a prompt about the issue (its key, summary and link; how to read it and which branch to start from are left to the agent) into a coding agent's session, **without sending it**: Implement asks for the work in a new `feature/<key>-<topic>` branch, Plan for an implementation plan without changing files, Chat for a short summary and to wait for questions. The prompts are in `agent.js` (`ACTIONS`). Any agent Herdr knows works, not only Claude. Where it goes depends on the agent sessions on screen: the panes of the shown tab, or only its zoomed pane when one is zoomed (other tabs don't count). None: a new tab named after the key, running the default agent, once it's ready. One: that one. Several: a list under the row to pick a session (its icon, session name, status and folder), a new tab of any installed agent, or cancel. Shift+click a button to always start a new tab of the default agent. The default agent is the first installed one in Herdr's `knownAgents()`, which lists the most picked first (the same order as the + menu); Claude Code until that list has loaded. The buttons show the icon of the agent a click reaches (none when the picker will ask), and their tooltip names it. The target gets the focus. Neither hc nor Herdr can type text without Enter (`hc send` submits, `hc keys` has no accents), so the prompt goes through the clipboard (GPUI's own, `cx.write_to_clipboard`, so it works on Windows, Linux and macOS) and `terminal.paste`, and the previous clipboard text is put back (only text: an image or files on it are lost).
- **Filter bars** under the header: **Statut** (a chip per status in the results) and **Type** (a chip per issue type, by name, with its tag colour). Click a chip to show or hide those issues; hidden chips are dimmed. A chip's count is what it would show given the other bar's filter. The header shows `shown / total`.
- **Status order:** drag a status chip (press on one, release on another) and it takes that one's place. The dragged chip fades, a ghost copy follows the pointer once it has moved a few px, and the target is outlined; releasing elsewhere or leaving the panel cancels. The order also orders the sub-groups in every project. By default, and for statuses it doesn't know yet (they go after), it's in-progress first (yellow dot), then to-do, then by name.
- **Reset filters:** a link in the header, shown when something is hidden or the order was changed. It shows every status and type again and goes back to the automatic order. Folds are kept.
- **Remembered:** hidden statuses and types (by name, across projects), the status order and the folds, in the mod's `localStorage` (`<Herdr home>/data/leddt-jira/store.json`). One set for the whole window, not per space, and not in this repo.
- **Data:** runs the `twg` CLI (`twg jira workitem query --jql ... -o json`), so it uses twg's own sign-in and site and holds no token. `twg` has to be on the PATH and signed in. It reads up to 5 pages of 100 issues; each call takes about 2s. It refreshes when the panel loads, every 2 minutes (even while the panel is hidden), and with ↻ in the header. If twg fails, its first error line shows under the header.

### `leddt-review`

A code-review loop for a Claude pane, started from the pane header's **Review** button.

- **Base picker** (a popup): lists the branches the current one could have come from, nearest first, down to the trunk (`main`, `master`, `develop` or `trunk`). Only local branches are listed; remote ones (`origin/*`) can still be typed. For each one it counts the commits on HEAD that the branch doesn't have (one `git for-each-ref` with `%(ahead-behind:HEAD)`, git 2.41+), and drops branches that have them all. That way an epic branch shows up first even after it has moved on. Up to 25 rows; only those get a `git merge-base` with HEAD. A text field takes any other ref (tag, SHA). Up/Down/Enter or click to start. The choice is remembered per repo and branch in the shared value `leddt-review.bases` and pre-selected next time.
- **Start:** starts a fresh `claude` with `hc run` in the same folder, as a sub-agent of the original agent (`--parent`, `--no-notify` so hc types nothing into the original, `--outlive-parent`). Its first message is `/code-review` scoped to `git diff <merge-base>` (committed changes since the base plus uncommitted ones). It gets `--add-dir` and an `Edit(...)` allow rule for its session folder, so it can write its results without asking. The **Findings** pane opens to the right of the original agent. The reviewer gets no pane: it stays a sub-agent of the original one.
- **Findings pane:** one card per finding, with a checkbox (checked by default) and a title line that starts with the finding's id in an outlined tag. Under the title are its state, the triage status (Valid/Invalid/Partial) and impact (Trivial/Minor/Major/Critical), the file:line, and the recommendation. Click a card to expand the description, the failure scenario, the triage reason, and the fix and verification notes. The header links go to the original agent and the reviewer: they focus its pane, or peek at it in a popup when it has none (a sub-agent), as the agents list does. The header also shows and show progress (`done/total`, round). A line under the header says what's running, or that an agent needs you (a permission dialog).
- **List / Diff** (in the header, remembered): Diff shows the findings as comments on the code. Each file with findings is a block taken from `git diff <base>` with the whole file as context (changed lines in green and red, as in Changes), cut down to 5 lines before and after each finding's line, with "⋯ N lines" between. The card sits under its line, which is highlighted. Findings with no line, or whose line is gone, sit at the top of their file's block; findings with no file go in a "Not about a file" section. Files over 400 KB aren't shown. A file name (the block's title, or a card's file:line) opens it in Files. In List, a card's file:line opens Diff with only that finding, and **Show all N findings** brings back the rest (a script can only scroll a virtual list, and those take no click handlers). The view rereads the code when a fix comes back, when a finding's file or line changes, and every 15s.
- **Line anchors:** when a report arrives, the text of each finding's line is kept (`anchor` in `state.json`). If the code above it moves, the Diff view puts the comment on the nearest line with that text, or says "Line N has changed since the review" when there's none.
- **States:** New → Triaging → Triaged → Fixing → Fixed → Verifying → Verified. Verified is done: grayed out, struck through, unchecked. If a fix is declined or verification fails, the finding goes back to Triaged with the reason in red.
- **Workflow:** once `/code-review` ends, the reviewer is asked to write its findings as JSON (`findings-r<round>.json`, ids `R<round>-<n>`). New findings go to the original agent for triage straight away (`triage-<n>.json`). **Fix** sends the checked Triaged findings to the original agent (`fix-<n>.json`). Each Triaged finding has an optional instruction field (e.g. "Create a Jira issue"): it goes with the finding and takes precedence over the triage and a code fix, and Verify then checks that it was followed. Left empty, the agent fixes the finding as usual. The instruction is kept on the finding (`instruction` in `state.json`). **Verify** asks the reviewer to recheck the checked Fixed findings (`verify-<n>.json`). **New round** asks the same reviewer for another round, scoped to the same base, with repeats of earlier findings marked. **Triage** shows up when checked findings are still New (for example after a dismissed request). Each agent gets one request at a time. Others wait in order and go out when its turn ends; the line under the header shows them as "Next for …" with a dim dot. Buttons are disabled while their agent is busy, and Verify and New round are disabled once the reviewer has ended.
- **Ignore** (in the footer, when checked findings are New, Triaged or Fixed): moves them to **Ignored**, which counts as done like Verified: grayed out, unchecked, left out of **All**, and counted in the header's "done". An ignored card has a **Restore** link that puts it back to the state it was ignored from (`ignoredFrom` in `state.json`), checked again. The key command is `leddt-review:ignore`.
- **Archive done** (in the footer, when there are any): hides the Verified and Ignored findings from the list. They stay in the session and its count; the header shows how many are archived.
- **Done** (in the header): asks for confirmation (the shipped `confirm` dialog), then saves the session one last time, ends the reviewer, moves the session folder to `<Herdr home>/data/leddt-review-archive/<id>/` and closes the Findings pane. Requests still in progress are dropped. The Review button no longer finds an archived session, so the next click starts a new one. The confirmation reaches the pane through the command `leddt-review.archive-<id>`. Mod command names only take a-z and `-`, so each digit of the id is written as `-a`…`-j`.
- **How requests work:** each one is a message sent with `hc send --wait`, ending with the path of the JSON file to write. The pane watches the session folder and applies a file as soon as it's valid. If the agent's turn ends without one, or the agent is gone, the request shows as failed with **Retry** (send again) and **Dismiss** (put the findings back in their previous state). The prompts are in `session.js`.
- **Persistence:** each session lives in `<Herdr home>/data/leddt-review-sessions/<id>/` (`state.json` plus the agents' files), not in this repo. Pending requests are saved before they're sent, so a reload or restart picks up waiting where it left off without sending twice. A result file is validated in full before anything changes. If the state can't be saved, a notification says so (once per run of failures).
- **Key commands:** `leddt-review:fix`, `leddt-review:verify`, `leddt-review:loop` and `leddt-review:triage` can be bound in `keys.json` (they reach every Findings pane on screen, but only the one whose agent or reviewer is in the focused tab acts).
- The original agent isn't started by the mod, so its first write to the session folder may ask for permission, depending on its mode. An allow rule for `Edit(~/.config/herdr-app/data/leddt-review-sessions/**)` in `~/.claude/settings.json` avoids that.

### `leddt-markdown`

A pane that renders a markdown file (`TextView.markdown`, text selectable), opened from the eye button in `leddt-files`. Its props are `{ file, on }` (an absolute path, and the machine). It reads the file again when it changes: a folder watch for local files, every 5s for a file on another machine. Files over 400 KB are cut. A link to another `.md` file opens it in the same pane, with a ← bar to go back; a web link, or a link to another local file, opens with the system's default app (`xdg-open`, `open`, or `Start-Process` on Windows).

### `leddt-command`

A full-width command line between the panes and the status bar, with only a top border. It starts with a terminal icon and the folder the command will run in, then `>`, so it doesn't read as an agent's prompt. Type a command and press Enter: a new terminal opens below the focused pane of the shown tab (its first pane when the focus is elsewhere), in that pane's folder (for a mod pane, the tab's first terminal's), and runs it. The terminal is named after the command and stays at a shell prompt when the command ends: on Windows, PowerShell 7 (`pwsh -NoExit -Command`, or Windows PowerShell when `pwsh` isn't installed); elsewhere and on other machines, `$SHELL -ic`, then an interactive `$SHELL`. Up/Down go through the last 100 commands (the mod's `localStorage`), Esc clears the field.

## Theme: `themes/leddt-solarized-light.json`

A light theme built from the [Solarized](https://ethanschoonover.com/solarized/) Light palette. The terminal uses `base3` as its background, and the sidebars and bars use `base2`. The accent is blue. Status colours: working is yellow, blocked is red, done is green. Changes from the original scheme, all for readability: body text is `base01` instead of `base00`. Every ANSI hue is darkened (same hue, scaled toward black) to at least 4.5:1 against the background; the originals were as low as 2.9:1 for yellow, cyan and green. The bright ANSI colours keep their hues instead of turning into greys. ANSI white is `base1`, so "white" text stays visible, and the selection is a bit darker than `base2`. Pick it from the theme menu.
