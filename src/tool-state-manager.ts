export interface ToolStateInfo {
  isEnabled: boolean;
  reason?: string;
}

interface ToolRule {
  requiresConnection?: boolean;
  requiresPause?: boolean;
  onlyWhenDisconnected?: boolean;
}

// Simple rules for each tool
const TOOL_RULES: Record<string, ToolRule> = {
  // Connection tools - only when disconnected
  'attach': { onlyWhenDisconnected: true },
  'launch': { onlyWhenDisconnected: true },

  // Disconnection tools - only when connected
  'disconnect': { requiresConnection: true },
  'terminate': { requiresConnection: true },
  'restart': { requiresConnection: true },

  // Breakpoint management - require connection
  'setBreakpoints': { requiresConnection: true },
  'removeBreakpoint': { requiresConnection: true },
  'getBreakpoints': { requiresConnection: true },
  'setExceptionBreakpoints': { requiresConnection: true },
  'breakpointLocations': { requiresConnection: true },

  // Execution control - basic ones require connection
  'continue': { requiresConnection: true },
  'pause': { requiresConnection: true },

  // Stepping - require connection and pause
  'next': { requiresConnection: true, requiresPause: true },
  'stepIn': { requiresConnection: true, requiresPause: true },
  'stepOut': { requiresConnection: true, requiresPause: true },
  'goto': { requiresConnection: true, requiresPause: true },
  'restartFrame': { requiresConnection: true, requiresPause: true },

  // Variable inspection - require connection
  'evaluate': { requiresConnection: true },
  'stackTrace': { requiresConnection: true },
  'variables': { requiresConnection: true },
  'scopes': { requiresConnection: true },
  'setVariable': { requiresConnection: true },
  'threads': { requiresConnection: true },
  'loadedSources': { requiresConnection: true },
  'exceptionInfo': { requiresConnection: true },

  // Utility tools - always available
  'getLogpointHits': {},
  'clearLogpointHits': {},
  'getDebuggerEvents': {},
  'clearDebuggerEvents': {},
  'getDebuggerState': {},
  'resolveOriginalPosition': {},
  'resolveGeneratedPosition': {},
};

export class ToolStateManager {
  private isConnected = false;
  private isPaused = false;
  private readonly stateChangeCallbacks: Array<(isConnected: boolean, isPaused: boolean) => void> = [];

  // State management
  setConnection(connected: boolean): void {
    if (this.isConnected !== connected) {
      this.isConnected = connected;
      // Reset pause state when disconnected
      if (!connected) {
        this.isPaused = false;
      }
      this.notifyStateChange();
    }
  }

  setPaused(paused: boolean): void {
    if (this.isPaused !== paused) {
      this.isPaused = paused;
      this.notifyStateChange();
    }
  }

  // Tool availability checking
  isToolEnabled(toolName: string): boolean {
    const rule = TOOL_RULES[toolName];

    if (!(toolName in TOOL_RULES)) {
      return false;
    }

    // Check rules in priority order
    if (rule.onlyWhenDisconnected && this.isConnected) return false;
    if (rule.requiresConnection && !this.isConnected) return false;
    if (rule.requiresPause && !this.isPaused) return false;

    return true;
  }

  getToolState(toolName: string): ToolStateInfo {
    const rule = TOOL_RULES[toolName];

    if (!(toolName in TOOL_RULES)) {
      return {
        isEnabled: false,
        reason: `Unknown tool: ${toolName}`,
      };
    }

    const isEnabled = this.isToolEnabled(toolName);

    return {
      isEnabled,
      reason: isEnabled ? undefined : this.getDisabledReason(toolName, rule),
    };
  }

  private getDisabledReason(toolName: string, rule: ToolRule): string {
    if (rule.onlyWhenDisconnected && this.isConnected) {
      return 'Only available when disconnected from debugger';
    }
    if (rule.requiresConnection && !this.isConnected) {
      return 'Requires debugger connection';
    }
    if (rule.requiresPause && !this.isPaused) {
      return 'Requires debugger to be paused';
    }

    return 'Tool disabled';
  }

  // Utility methods for compatibility
  getAllEnabledTools(): string[] {
    return Object.keys(TOOL_RULES).filter(tool => this.isToolEnabled(tool));
  }

  getAllDisabledTools(): string[] {
    return Object.keys(TOOL_RULES).filter(tool => !this.isToolEnabled(tool));
  }

  // Event handling
  onStateChange(callback: (isConnected: boolean, isPaused: boolean) => void): () => void {
    this.stateChangeCallbacks.push(callback);

    // Return unsubscribe function
    return () => {
      const index = this.stateChangeCallbacks.indexOf(callback);

      if (index > -1) {
        this.stateChangeCallbacks.splice(index, 1);
      }
    };
  }

  private notifyStateChange(): void {
    this.stateChangeCallbacks.forEach(callback => {
      try {
        callback(this.isConnected, this.isPaused);
      } catch (error) {
        console.error('Error in state change callback:', error);
      }
    });
  }

  // Debug information
  getDebugInfo(): {
    state: string;
    isConnected: boolean;
    isPaused: boolean;
    enabledTools: string[];
    disabledTools: string[];
    enabledDomains: string[];
    stateDescription: string;
  } {
    const state = this.getCurrentState();
    const stateDescriptions = {
      'disconnected': 'Not connected to debugger',
      'connected': 'Connected to debugger',
      'debuggerPaused': 'Debugger paused at breakpoint or step',
    };

    return {
      state,
      isConnected: this.isConnected,
      isPaused: this.isPaused,
      enabledTools: this.getAllEnabledTools(),
      disabledTools: this.getAllDisabledTools(),
      enabledDomains: this.isConnected ? ['Debugger', 'Runtime', 'Console'] : [],
      stateDescription: stateDescriptions[state as keyof typeof stateDescriptions] || 'Unknown state',
    };
  }

  // Backward compatibility methods
  getCurrentState(): string {
    if (!this.isConnected) return 'disconnected';

    return this.isPaused ? 'debuggerPaused' : 'connected';
  }

  isPausedState(): boolean {
    return this.isPaused;
  }
}
