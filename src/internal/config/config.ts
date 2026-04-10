import { ClaudeWrapper } from "../../clients/claude";

const DEFAULT_PANE_WIDTH = 120;
const DEFAULT_PANE_HEIGHT = 40;

export function newClaudeWrapper(
  model: string,
  cwd: string,
  tmuxSession: string,
): ClaudeWrapper {
  if (!model) model = "sonnet";
  return new ClaudeWrapper({
    model,
    permissionMode: "default",
    workingDir: cwd,
    tmuxSession,
    paneWidth: DEFAULT_PANE_WIDTH,
    paneHeight: DEFAULT_PANE_HEIGHT,
  });
}
