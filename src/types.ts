import type { NodeJSDebugAdapter } from "./nodejs-debug-adapter.js";

export interface DebuggerConnection {
  adapter: NodeJSDebugAdapter | null;
  isConnected: boolean;
  webSocketUrl?: string;
}

export interface TruncationOptions {
  maxLength?: number;
  maxDepth?: number;
  maxArrayItems?: number;
  maxObjectKeys?: number;
  summary?: boolean;
}

export interface LogpointHit {
  // Optional human-readable message, derived from payload when present
  message?: string;
  // Raw payload string as sent from Runtime.bindingCalled
  payloadRaw?: string;
  // Parsed JSON payload, if applicable
  payload?: unknown;
  timestamp: Date;
  executionContextId: number;
  stackTrace?: unknown;
  level?: string;
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
    condition?: string;
    logMessage?: string;
  };
  actualLocation: {
    scriptId?: string;
    lineNumber: number;
    columnNumber: number;
  };
  sourceMapResolution: {
    used: boolean;
    sourceMapFile?: string;
    matchedSource?: string;
    targetFile?: string;
    targetLocation?: {
      lineNumber: number;
      columnNumber: number;
    };
  };
  timestamp: Date;
}

export interface SourceCodeContext {
  filePath: string;
  targetLine: number;
  lines: Array<{
    lineNumber: number;
    content: string;
    isTarget?: boolean;
    hasBreakpoint?: boolean;
    hasLogpoint?: boolean;
  }>;
  recommendation?: string;
}
