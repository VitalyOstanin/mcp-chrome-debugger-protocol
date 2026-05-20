// Centralised tunables. Numbers spread across files used to surface as separate
// "magic numbers" review findings -- fix them in one place from now on.

export const DEFAULTS = {
  INSPECTOR_PORT: 9229,
  // Inspector binds to loopback for security (see attachRequest); the client
  // host can stay as 'localhost' to retain the user's resolver behaviour.
  INSPECTOR_HOST: '127.0.0.1',
  INSPECTOR_CLIENT_HOST: 'localhost',
  // Timeout for in-process DAP requests dispatched via DAPClient.sendRequest.
  DAP_REQUEST_TIMEOUT_MS: 10_000,
  // Inspector port discovery loop in DAPClient.enableDebuggerPid.
  DISCOVER_TIMEOUT_MS: 8_000,
  // Single inspector probe attempt timeout.
  PROBE_TIMEOUT_MS: 400,
  // Wait between strace lines before deciding the inspector did not announce.
  STRACE_TIMEOUT_MS: 8_000,
  // Sleep between inspector probe rounds in pollForInspectorPort.
  INSPECTOR_POLL_INTERVAL_MS: 200,
  // `which`-style command availability probe (isCommandAvailable).
  COMMAND_AVAILABILITY_TIMEOUT_MS: 1_000,
  // Truncation default for tool responses (manager.truncateResult).
  TRUNCATE_MAX_LENGTH: 20_000,
  // Bounded buffers in DAPClient (logpoint hits, debugger events).
  MAX_BUFFER_SIZE: 10_000,
  // Polling for scriptParsed in NodeJSDebugAdapter.getScriptIdForPath.
  SCRIPT_LOOKUP_POLL_INTERVAL_MS: 50,
  SCRIPT_LOOKUP_DEFAULT_TIMEOUT_MS: 1_000,
} as const;

// Synthetic "wide enough" right edge for Debugger.getPossibleBreakpoints when
// the caller did not pass an endColumn. CDP requires a column; 200 is large
// enough for any realistic source line and small enough to avoid CDP issues.
export const END_COLUMN_LARGE = 200;

// Search windows used by placeBreakpointByScriptId when the requested column
// has no possible breakpoint location nearby. Each window is [delta, range]:
// scan from line+delta over `range` lines. Windows widen on each retry so the
// fallback finds the nearest valid statement without being unbounded.
export const BREAKPOINT_SEARCH_WINDOWS: ReadonlyArray<readonly [number, number]> = [
  [0, 10],
  [-2, 20],
  [-10, 50],
];

// Compiled-output directories scanned for .js.map files.
export const BUILD_DIRS: readonly string[] = ['dist', 'build', 'out', 'lib'];

// Marker that distinguishes an authored TS file from its compiled sibling.
export const SOURCE_DIR_MARKER = '/src/';

// Range of inspector ports DAPClient will probe when strace cannot pin one.
export const INSPECTOR_PORT_RANGE = {
  start: 9229,
  end: 9250,
} as const;

// DAP-protocol numeric error codes used by NodeJSDebugAdapter.sendErrorResponse.
// DAP itself does not define a registry of codes; the convention is "1000+ is
// adapter-private". Keep them here so the inline `1001..1009` magic numbers
// don't get reused inconsistently and so the matching DAP doc strings can be
// kept next to the value.
export const DAP_ERROR_CODES = {
  LAUNCH_PROGRAM_REQUIRED: 1001,
  LAUNCH_FAILED: 1002,
  ATTACH_FAILED: 1003,
  SET_BREAKPOINTS_FAILED: 1004,
  CONTINUE_FAILED: 1005,
  PAUSE_FAILED: 1006,
  STEP_IN_FAILED: 1007,
  STEP_OUT_FAILED: 1008,
  NEXT_FAILED: 1009,
} as const;
