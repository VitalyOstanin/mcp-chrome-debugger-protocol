import type { NodeJSDebugAdapter } from "./nodejs-debug-adapter.js";

export interface DebuggerConnection {
  adapter: NodeJSDebugAdapter | null;
  isConnected: boolean;
  webSocketUrl?: string | undefined;
}

export interface TruncationOptions {
  maxLength?: number | undefined;
  maxDepth?: number | undefined;
  maxArrayItems?: number | undefined;
  maxObjectKeys?: number | undefined;
  summary?: boolean | undefined;
}

export interface LogpointHit {
  // Optional human-readable message, derived from payload when present
  message?: string | undefined;
  // Raw payload string as sent from Runtime.bindingCalled
  payloadRaw?: string | undefined;
  // Parsed JSON payload, if applicable
  payload?: unknown | undefined;
  timestamp: Date;
  executionContextId: number;
  stackTrace?: unknown | undefined;
  level?: string | undefined;
}

export interface DebuggerEvent {
  type: 'paused' | 'resumed';
  timestamp: Date;
  data: Record<string, unknown>;
}

export interface TrackedBreakpoint {
  breakpointId: number;
  type: 'breakpoint' | 'logpoint';
  originalRequest: {
    filePath: string;
    lineNumber: number;
    columnNumber: number;
    condition?: string | undefined;
    logMessage?: string | undefined;
  };
  actualLocation: {
    scriptId?: string | undefined;
    lineNumber: number;
    columnNumber: number;
  };
  sourceMapResolution: {
    used: boolean;
    sourceMapFile?: string | undefined;
    matchedSource?: string | undefined;
    targetFile?: string | undefined;
    targetLocation?: {
      lineNumber: number;
      columnNumber: number;
    };
  };
  timestamp: Date;
}

