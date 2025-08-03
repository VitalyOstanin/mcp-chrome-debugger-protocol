import CDP from "chrome-remote-interface";
import type { Protocol } from 'devtools-protocol';

export interface DebuggerConnection {
  client: CDP.Client | null;
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
  message: string;
  timestamp: Date;
  executionContextId: number;
  stackTrace?: Protocol.Runtime.StackTrace;
  level?: 'info' | 'warn' | 'error' | 'debug';
}

export interface DebuggerEvent {
  type: 'paused' | 'resumed';
  timestamp: Date;
  data: Protocol.Debugger.PausedEvent | Record<string, never>;
}

export interface TrackedBreakpoint {
  breakpointId: string;
  type: 'breakpoint' | 'logpoint';
  originalRequest: {
    filePath: string;
    lineNumber: number;
    columnNumber: number;
    condition?: string;
    logMessage?: string;
  };
  actualLocation?: {
    scriptId?: string;
    lineNumber: number;
    columnNumber: number;
  };
  sourceMapResolution?: {
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
