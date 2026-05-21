import { describe, expect, it } from 'vitest';
import { ToolStateManager } from './tool-state-manager.js';

describe('ToolStateManager.getCurrentState', () => {
  it('returns "disconnected" when not connected', () => {
    const m = new ToolStateManager();

    expect(m.getCurrentState()).toBe('disconnected');
  });

  it('returns "connected" when connected and not paused', () => {
    const m = new ToolStateManager();

    m.setConnection(true);
    expect(m.getCurrentState()).toBe('connected');
  });

  it('returns "debuggerPaused" when connected and paused', () => {
    const m = new ToolStateManager();

    m.setConnection(true);
    m.setPaused(true);
    expect(m.getCurrentState()).toBe('debuggerPaused');
  });

  it('resets pause state on disconnect', () => {
    const m = new ToolStateManager();

    m.setConnection(true);
    m.setPaused(true);
    m.setConnection(false);
    expect(m.isPausedState()).toBe(false);
  });

  it('ignores setPaused(true) while disconnected (spurious late event)', () => {
    const m = new ToolStateManager();

    m.setPaused(true);
    expect(m.isPausedState()).toBe(false);
    expect(m.getCurrentState()).toBe('disconnected');
  });

  it('drops a late paused event that arrives after disconnect', () => {
    const m = new ToolStateManager();

    m.setConnection(true);
    m.setConnection(false);
    m.setPaused(true);
    expect(m.isPausedState()).toBe(false);
    expect(m.getCurrentState()).toBe('disconnected');
  });

  it('still honours setPaused(false) even when disconnected', () => {
    const m = new ToolStateManager();

    m.setPaused(false);
    expect(m.isPausedState()).toBe(false);
  });
});

describe('ToolStateManager.isToolEnabled rules', () => {
  it('attach: only when disconnected', () => {
    const m = new ToolStateManager();

    expect(m.isToolEnabled('attach')).toBe(true);
    m.setConnection(true);
    expect(m.isToolEnabled('attach')).toBe(false);
  });

  it('disconnect: only when connected', () => {
    const m = new ToolStateManager();

    expect(m.isToolEnabled('disconnect')).toBe(false);
    m.setConnection(true);
    expect(m.isToolEnabled('disconnect')).toBe(true);
  });

  it('next: requires connection AND pause', () => {
    const m = new ToolStateManager();

    expect(m.isToolEnabled('next')).toBe(false);
    m.setConnection(true);
    expect(m.isToolEnabled('next')).toBe(false);
    m.setPaused(true);
    expect(m.isToolEnabled('next')).toBe(true);
  });

  it('setBreakpointsBatch: requires connection like setBreakpoints', () => {
    const m = new ToolStateManager();

    expect(m.isToolEnabled('setBreakpointsBatch')).toBe(false);
    m.setConnection(true);
    expect(m.isToolEnabled('setBreakpointsBatch')).toBe(true);
  });

  it('utility tools (getDebuggerState) are always enabled', () => {
    const m = new ToolStateManager();

    expect(m.isToolEnabled('getDebuggerState')).toBe(true);
    m.setConnection(true);
    expect(m.isToolEnabled('getDebuggerState')).toBe(true);
  });

  it('unknown tool returns false', () => {
    const m = new ToolStateManager();

    expect(m.isToolEnabled('nonexistentTool')).toBe(false);
  });
});

describe('ToolStateManager.getToolState', () => {
  it('returns isEnabled=true without reason for enabled tool', () => {
    const m = new ToolStateManager();

    expect(m.getToolState('attach')).toEqual({ isEnabled: true });
  });

  it('explains "Requires debugger connection" for disabled connection-required tool', () => {
    const m = new ToolStateManager();
    const info = m.getToolState('continue');

    expect(info).toEqual({ isEnabled: false, reason: 'Requires debugger connection' });
  });

  it('explains "Requires debugger to be paused" for stepping tools', () => {
    const m = new ToolStateManager();

    m.setConnection(true);

    const info = m.getToolState('next');

    expect(info).toEqual({ isEnabled: false, reason: 'Requires debugger to be paused' });
  });

  it('explains "Only available when disconnected" for attach when connected', () => {
    const m = new ToolStateManager();

    m.setConnection(true);

    const info = m.getToolState('attach');

    expect(info).toEqual({ isEnabled: false, reason: 'Only available when disconnected from debugger' });
  });

  it('returns "Unknown tool" reason for unknown tool', () => {
    const m = new ToolStateManager();
    const info = m.getToolState('xxx');

    expect(info).toEqual({ isEnabled: false, reason: 'Unknown tool: xxx' });
  });
});

describe('ToolStateManager.onStateChange callbacks', () => {
  it('fires callback on connection state change', () => {
    const m = new ToolStateManager();
    const events: Array<[boolean, boolean]> = [];

    m.onStateChange((c, p) => events.push([c, p]));
    m.setConnection(true);
    expect(events).toEqual([[true, false]]);
  });

  it('does NOT fire callback when state did not change', () => {
    const m = new ToolStateManager();
    const events: boolean[] = [];

    m.setConnection(true);
    m.onStateChange((c) => events.push(c));
    m.setConnection(true);
    expect(events).toEqual([]);
  });

  it('fires callback on pause state change', () => {
    const m = new ToolStateManager();

    m.setConnection(true);

    const events: Array<[boolean, boolean]> = [];

    m.onStateChange((c, p) => events.push([c, p]));
    m.setPaused(true);
    expect(events).toEqual([[true, true]]);
  });

  it('unsubscribe stops further callback invocations', () => {
    const m = new ToolStateManager();
    let count = 0;
    const off = m.onStateChange(() => { count += 1; });

    m.setConnection(true);
    off();
    m.setConnection(false);
    expect(count).toBe(1);
  });

  it('keeps emitting to remaining subscribers when one throws', () => {
    const m = new ToolStateManager();
    let okCount = 0;

    m.onStateChange(() => { throw new Error('boom'); });
    m.onStateChange(() => { okCount += 1; });
    m.setConnection(true);
    expect(okCount).toBe(1);
  });
});

describe('ToolStateManager.getAllEnabledTools / getAllDisabledTools', () => {
  it('lists utility tools as enabled when disconnected', () => {
    const m = new ToolStateManager();
    const enabled = m.getAllEnabledTools();

    expect(enabled).toContain('attach');
    expect(enabled).toContain('getDebuggerState');
    expect(enabled).not.toContain('continue');
  });

  it('partitions tools without overlap', () => {
    const m = new ToolStateManager();
    const enabled = new Set(m.getAllEnabledTools());
    const disabled = new Set(m.getAllDisabledTools());

    for (const tool of enabled) {
      expect(disabled.has(tool)).toBe(false);
    }
  });
});

describe('ToolStateManager.getDebugInfo', () => {
  it('reports disconnected state with empty enabledDomains', () => {
    const m = new ToolStateManager();
    const info = m.getDebugInfo();

    expect(info.state).toBe('disconnected');
    expect(info.isConnected).toBe(false);
    expect(info.isPaused).toBe(false);
    expect(info.enabledDomains).toEqual([]);
    expect(info.stateDescription).toBe('Not connected to debugger');
  });

  it('reports connected state with non-empty enabledDomains', () => {
    const m = new ToolStateManager();

    m.setConnection(true);

    const info = m.getDebugInfo();

    expect(info.state).toBe('connected');
    expect(info.enabledDomains).toEqual(['Debugger', 'Runtime', 'Console']);
  });

  it('reports debuggerPaused with stepping tools enabled', () => {
    const m = new ToolStateManager();

    m.setConnection(true);
    m.setPaused(true);

    const info = m.getDebugInfo();

    expect(info.state).toBe('debuggerPaused');
    expect(info.enabledTools).toContain('next');
    expect(info.enabledTools).toContain('stepIn');
    expect(info.stateDescription).toBe('Debugger paused at breakpoint or step');
  });
});
