// Centralised tunables. Numbers spread across files used to surface as separate
// "magic numbers" review findings -- fix them in one place from now on.

export const DEFAULTS = {
  INSPECTOR_PORT: 9229,
  INSPECTOR_HOST: '127.0.0.1',
  // Timeout for in-process DAP requests dispatched via DAPClient.sendRequest.
  DAP_REQUEST_TIMEOUT_MS: 10_000,
  // Inspector port discovery loop in DAPClient.enableDebuggerPid.
  DISCOVER_TIMEOUT_MS: 8_000,
  // Single inspector probe attempt timeout.
  PROBE_TIMEOUT_MS: 400,
  // Wait between strace lines before deciding the inspector did not announce.
  STRACE_TIMEOUT_MS: 8_000,
  // Truncation default for tool responses (manager.truncateResult).
  TRUNCATE_MAX_LENGTH: 20_000,
  // Bounded buffers in DAPClient (logpoint hits, debugger events).
  MAX_BUFFER_SIZE: 10_000,
  // Polling for scriptParsed in NodeJSDebugAdapter.getScriptIdForPath.
  SCRIPT_LOOKUP_POLL_INTERVAL_MS: 50,
  SCRIPT_LOOKUP_DEFAULT_TIMEOUT_MS: 1_000,
} as const;

// Compiled-output directories scanned for .js.map files.
export const BUILD_DIRS: readonly string[] = ['dist', 'build', 'out', 'lib'];

// Marker that distinguishes an authored TS file from its compiled sibling.
export const SOURCE_DIR_MARKER = '/src/';

// Range of inspector ports DAPClient will probe when strace cannot pin one.
export const INSPECTOR_PORT_RANGE = {
  start: 9229,
  end: 9250,
} as const;
