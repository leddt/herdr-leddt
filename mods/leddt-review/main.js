// Code review loop for a Claude pane.
// - As a popup (props.mode "pick", opened by leddt-pane's Review button):
//   pick the base branch and start a session (./pick.js).
// - As a pane (props.session): the session's findings and the
//   Triage / Fix / Verify / Loop workflow (./findings.js).
import { View } from "gpui-kit";
import { props } from "herdr";
import { Picker } from "./pick.js";
import { Findings } from "./findings.js";

export default class Review extends View {
  init(_props, cx) {
    this.impl = props()?.mode === "pick" ? new Picker() : new Findings();
    this.impl.init(this, cx);
  }

  render(cx) {
    return this.impl.render(cx);
  }
}
