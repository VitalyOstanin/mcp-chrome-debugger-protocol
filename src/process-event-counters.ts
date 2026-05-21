// Module-level counters for top-level process events. Surfaced via
// getDebuggerState so MCP clients can detect background async rejections that
// would otherwise only appear in stderr logs -- a debug session may continue
// to look "healthy" while a CDP event handler is silently rejecting on every
// pause/script-parsed.
//
// uncaughtException is intentionally not tracked here: the index.ts handler
// for it exits the process, so no client could ever observe the counter
// transitioning from 0 to non-zero.
const counters = {
  unhandledRejection: 0,
};

export function incrementUnhandledRejection(): void {
  counters.unhandledRejection += 1;
}

export function getProcessEventCounters(): { unhandledRejection: number } {
  return { unhandledRejection: counters.unhandledRejection };
}

// Test-only reset to keep counters from leaking across vitest cases that
// share the module graph.
export function resetProcessEventCounters(): void {
  counters.unhandledRejection = 0;
}
