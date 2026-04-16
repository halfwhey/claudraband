import type {
  ClaudrabandPermissionDecision,
  ClaudrabandPermissionRequest,
  PermissionMode,
} from "claudraband-core";

export function autoDecisionForPermissionMode(
  permissionMode: PermissionMode,
  request: ClaudrabandPermissionRequest,
): ClaudrabandPermissionDecision | null {
  const autoApproveModes = new Set<PermissionMode>([
    "auto",
    "dontAsk",
    "bypassPermissions",
  ]);
  if (!autoApproveModes.has(permissionMode)) {
    if (!(permissionMode === "acceptEdits" && request.kind === "edit")) {
      return null;
    }
  }

  const allowed = request.options.find((option) =>
    option.kind !== "reject_once" && !option.textInput
  );
  return allowed
    ? { outcome: "selected", optionId: allowed.optionId }
    : null;
}
