import {
  TOOL_REQUIREMENTS,
  STATE_COMMAND_MAP,
  isToolAllowedInState,
  getRequiredDomainsForTool,
  getToolsForState,
  ToolRequirement
} from "./generated/protocol-requirements.js";

export type DebuggerState = 'disconnected' | 'connected' | 'debuggerPaused';

export interface ToolStateInfo {
  isEnabled: boolean;
  reason?: string;
  requiredDomains?: string[];
}

export class ToolStateManager {
  private currentState: DebuggerState = 'disconnected';
  private isPaused: boolean = false;
  private enabledDomains: Set<string> = new Set();
  private stateChangeCallbacks: Array<(state: DebuggerState) => void> = [];

  constructor() {
    this.currentState = 'disconnected';
  }

  // State management
  getCurrentState(): DebuggerState {
    return this.currentState;
  }

  isPausedState(): boolean {
    return this.isPaused;
  }

  getEnabledDomains(): string[] {
    return Array.from(this.enabledDomains);
  }

  setState(newState: DebuggerState, isPaused: boolean = false): void {
    const oldState = this.currentState;

    this.currentState = newState;
    this.isPaused = isPaused;

    if (oldState !== newState) {
      this.notifyStateChange(newState);
    }
  }

  setConnection(connected: boolean): void {
    if (connected) {
      if (this.currentState === 'disconnected') {
        this.setState('connected');
      }
    } else {
      this.setState('disconnected');
      this.enabledDomains.clear();
      this.isPaused = false;
    }
  }

  enableDomain(domain: string): void {
    this.enabledDomains.add(domain);
    // No state transition needed - we stay in current state
  }

  disableDomain(domain: string): void {
    this.enabledDomains.delete(domain);
    // No state transition needed - we stay in current state
  }

  setPaused(paused: boolean): void {
    const oldPaused = this.isPaused;

    this.isPaused = paused;

    // Update state based on pause status
    if (paused && this.currentState === 'connected') {
      this.setState('debuggerPaused', true);
    } else if (!paused && this.currentState === 'debuggerPaused') {
      this.setState('connected', false);
    }

    // Notify even if state didn't change but pause status did
    if (oldPaused !== paused) {
      this.notifyStateChange(this.currentState);
    }
  }

  // Tool availability checking
  isToolEnabled(toolName: string): boolean {
    return this.getToolState(toolName).isEnabled;
  }

  getToolState(toolName: string): ToolStateInfo {
    const requirement = TOOL_REQUIREMENTS[toolName];

    if (!requirement) {
      return {
        isEnabled: false,
        reason: `Unknown tool: ${toolName}`
      };
    }

    const enabledDomainsArray = this.getEnabledDomains();
    const isAllowed = isToolAllowedInState(
      toolName,
      this.currentState,
      this.isPaused,
      enabledDomainsArray
    );

    if (!isAllowed) {
      const reasons = this.getDisabledReasons(toolName, requirement);

      return {
        isEnabled: false,
        reason: reasons.join(', '),
        requiredDomains: requirement.domains
      };
    }

    return {
      isEnabled: true,
      requiredDomains: requirement.domains
    };
  }

  private getDisabledReasons(toolName: string, requirement: ToolRequirement): string[] {
    const reasons: string[] = [];

    // Check connection requirement
    if (requirement.requiresConnection && this.currentState === 'disconnected') {
      reasons.push('requires connection');
    }

    // Check state compatibility first - this is the primary check
    const stateInfo = STATE_COMMAND_MAP[this.currentState];
    const isStateCompatible = stateInfo?.allowedTools.includes(toolName) ||
                             stateInfo?.allowedCategories.includes(requirement.category);

    if (!isStateCompatible) {
      reasons.push(`not available in ${this.currentState} state`);

      return reasons; // Early return if state doesn't allow the tool
    }

    // Check domain enablement requirement only if state allows the tool
    if (requirement.requiresEnable && requirement.domains.length > 0) {
      const missingDomains = requirement.domains.filter(domain =>
        !this.enabledDomains.has(domain)
      );

      if (missingDomains.length > 0) {
        reasons.push(`requires domains: ${missingDomains.join(', ')}`);
      }
    }

    // Check pause requirement
    if (requirement.requiresPause && !this.isPaused) {
      reasons.push('requires debugger to be paused');
    }

    return reasons;
  }

  getAllEnabledTools(): string[] {
    return getToolsForState(this.currentState, this.isPaused, this.getEnabledDomains());
  }

  getAllDisabledTools(): string[] {
    const allTools = Object.keys(TOOL_REQUIREMENTS);
    const enabledTools = this.getAllEnabledTools();

    return allTools.filter(tool => !enabledTools.includes(tool));
  }

  getToolsByCategory(category: string): { enabled: string[], disabled: string[] } {
    const enabled: string[] = [];
    const disabled: string[] = [];

    Object.keys(TOOL_REQUIREMENTS).forEach(toolName => {
      const requirement = TOOL_REQUIREMENTS[toolName];

      if (requirement.category === category) {
        if (this.isToolEnabled(toolName)) {
          enabled.push(toolName);
        } else {
          disabled.push(toolName);
        }
      }
    });

    return { enabled, disabled };
  }

  // Auto-enable required domains for a tool
  autoEnableDomainsForTool(toolName: string): boolean {
    const requiredDomains = getRequiredDomainsForTool(toolName);

    if (requiredDomains.length === 0) {
      return true; // No domains required
    }

    const missingDomains = requiredDomains.filter(domain =>
      !this.enabledDomains.has(domain)
    );

    if (missingDomains.length > 0) {
      missingDomains.forEach(domain => this.enableDomain(domain));

      return true;
    }

    return false; // No domains were enabled
  }

  // Event handling
  onStateChange(callback: (state: DebuggerState) => void): () => void {
    this.stateChangeCallbacks.push(callback);

    // Return unsubscribe function
    return () => {
      const index = this.stateChangeCallbacks.indexOf(callback);

      if (index > -1) {
        this.stateChangeCallbacks.splice(index, 1);
      }
    };
  }

  private notifyStateChange(newState: DebuggerState): void {
    this.stateChangeCallbacks.forEach(callback => {
      try {
        callback(newState);
      } catch (error) {
        console.error('Error in state change callback:', error);
      }
    });
  }

  // Debug information
  getDebugInfo(): {
    state: DebuggerState;
    isPaused: boolean;
    enabledDomains: string[];
    enabledTools: string[];
    disabledTools: string[];
    stateDescription: string;
  } {
    const stateInfo = STATE_COMMAND_MAP[this.currentState];

    return {
      state: this.currentState,
      isPaused: this.isPaused,
      enabledDomains: this.getEnabledDomains(),
      enabledTools: this.getAllEnabledTools(),
      disabledTools: this.getAllDisabledTools(),
      stateDescription: stateInfo?.description ?? 'Unknown state'
    };
  }
}
