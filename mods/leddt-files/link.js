// Ctrl-click (Cmd on macOS) on a Markdown file or an image in a terminal: shows it in a
// leddt-markdown or leddt-image pane, as a click on Files' eye button would (the latest
// preview in that tab is reused, else a new pane opens to the right of the clicked one).
// A remote terminal's image, or a path Herdr couldn't resolve, goes to the next handler.
import { preview } from "./preview.js";

// The runtime's own timer (what cx.sleep uses); a link handler has no cx. Without it, the
// preview still opens, but a new pane isn't noted or named.
const wait = typeof globalThis.__sleep === "function" ? (ms) => globalThis.__sleep(ms) : null;

export async function handleLink({ link, source }) {
  if (link.kind !== "file" || !link.path) return "pass";
  const where = { space: source.space, tab: source.tab, pane: source.pane };
  const folder = source.cwd ?? link.path.replace(/[\\/][^\\/]*$/, "");
  return (await preview(link.path, source.machine, folder, "reuse", wait, where)) ? "handled" : "pass";
}
