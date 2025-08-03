#!/usr/bin/env node

const { writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

// Анализ протокола CDP на основе экспортируемых возможностей модуля
function analyzeProtocol() {
  console.log('Analyzing CDP protocol capabilities...');
  
  const analysis = {
    domains: getKnownDomains(),
    toolRequirements: {},
    stateCommandMap: {},
    generatedAt: new Date().toISOString(),
    protocolVersion: 'static-analysis'
  };

  // Определение требований для инструментов MCP
  analysis.toolRequirements = {
    // Connection tools
    connect_default: { 
      requiresConnection: false, 
      requiresEnable: false, 
      requiresPause: false, 
      domains: [],
      category: 'connection'
    },
    connect_url: { 
      requiresConnection: false, 
      requiresEnable: false, 
      requiresPause: false, 
      domains: [],
      category: 'connection'
    },
    enable_debugger_pid: { 
      requiresConnection: false, 
      requiresEnable: false, 
      requiresPause: false, 
      domains: [],
      category: 'connection'
    },
    disconnect: { 
      requiresConnection: true, 
      requiresEnable: false, 
      requiresPause: false, 
      domains: [],
      category: 'disconnection'
    },

    // Breakpoint management
    set_breakpoint: { 
      requiresConnection: true, 
      requiresEnable: true, 
      requiresPause: false, 
      domains: ['Debugger'],
      category: 'debugging'
    },
    set_logpoint: { 
      requiresConnection: true, 
      requiresEnable: true, 
      requiresPause: false, 
      domains: ['Debugger'],
      category: 'debugging'
    },
    remove_breakpoint: { 
      requiresConnection: true, 
      requiresEnable: true, 
      requiresPause: false, 
      domains: ['Debugger'],
      category: 'debugging'
    },
    list_breakpoints: { 
      requiresConnection: true, 
      requiresEnable: true, 
      requiresPause: false, 
      domains: ['Debugger'],
      category: 'debugging'
    },

    // Execution control
    resume: { 
      requiresConnection: true, 
      requiresEnable: true, 
      requiresPause: true, 
      domains: ['Debugger'],
      category: 'debugging'
    },
    pause: { 
      requiresConnection: true, 
      requiresEnable: true, 
      requiresPause: false, 
      domains: ['Debugger'],
      category: 'debugging'
    },
    step_over: { 
      requiresConnection: true, 
      requiresEnable: true, 
      requiresPause: true, 
      domains: ['Debugger'],
      category: 'debugging'
    },
    step_into: { 
      requiresConnection: true, 
      requiresEnable: true, 
      requiresPause: true, 
      domains: ['Debugger'],
      category: 'debugging'
    },
    step_out: { 
      requiresConnection: true, 
      requiresEnable: true, 
      requiresPause: true, 
      domains: ['Debugger'],
      category: 'debugging'
    },

    // Inspection tools
    evaluate: { 
      requiresConnection: true, 
      requiresEnable: true, 
      requiresPause: false, 
      domains: ['Runtime', 'Debugger'],
      category: 'inspection'
    },
    get_call_stack: { 
      requiresConnection: true, 
      requiresEnable: true, 
      requiresPause: false, 
      domains: ['Runtime'],
      category: 'inspection'
    },
    get_scope_variables: { 
      requiresConnection: true, 
      requiresEnable: true, 
      requiresPause: true, 
      domains: ['Runtime'],
      category: 'inspection'
    },

    // Data tools
    get_logpoint_hits: { 
      requiresConnection: true, 
      requiresEnable: false, 
      requiresPause: false, 
      domains: [],
      category: 'data'
    },
    clear_logpoint_hits: { 
      requiresConnection: true, 
      requiresEnable: false, 
      requiresPause: false, 
      domains: [],
      category: 'data'
    },
    get_debugger_events: { 
      requiresConnection: true, 
      requiresEnable: false, 
      requiresPause: false, 
      domains: [],
      category: 'data'
    },
    clear_debugger_events: { 
      requiresConnection: true, 
      requiresEnable: false, 
      requiresPause: false, 
      domains: [],
      category: 'data'
    },
    get_debugger_state: { 
      requiresConnection: false, 
      requiresEnable: false, 
      requiresPause: false, 
      domains: [],
      category: 'inspection'
    },
    resolve_original_position: { 
      requiresConnection: false, 
      requiresEnable: false, 
      requiresPause: false, 
      domains: [],
      category: 'data'
    },
    resolve_generated_position: { 
      requiresConnection: false, 
      requiresEnable: false, 
      requiresPause: false, 
      domains: [],
      category: 'data'
    }
  };

  // Создание карты состояний
  analysis.stateCommandMap = {
    disconnected: {
      description: 'No connection to CDP',
      allowedCategories: ['connection', 'inspection', 'data'],
      allowedTools: []
    },
    connected: {
      description: 'Connected to CDP',
      allowedCategories: ['disconnection', 'debugging', 'inspection', 'data'],
      allowedTools: []
    },
    debuggerPaused: {
      description: 'Debugger paused on breakpoint',
      allowedCategories: ['disconnection', 'debugging', 'inspection', 'data'],
      allowedTools: [],
      additionalRequirements: {
        requiresPause: true
      }
    }
  };

  // Заполнение разрешенных инструментов для всех состояний
  Object.keys(analysis.toolRequirements).forEach(toolName => {
    const requirements = analysis.toolRequirements[toolName];
    
    if (requirements.requiresConnection) {
      if (!requirements.requiresPause) {
        // Инструменты, не требующие паузы, доступны в connected и debuggerPaused
        analysis.stateCommandMap.connected.allowedTools.push(toolName);
        analysis.stateCommandMap.debuggerPaused.allowedTools.push(toolName);
      } else {
        // Инструменты, требующие паузы, доступны только в состоянии debuggerPaused
        analysis.stateCommandMap.debuggerPaused.allowedTools.push(toolName);
      }
    } else {
      // Инструменты, не требующие подключения
      if (requirements.category === 'connection') {
        // Connection tools доступны только в disconnected
        analysis.stateCommandMap.disconnected.allowedTools.push(toolName);
      } else if (requirements.category === 'inspection' || requirements.category === 'data') {
        // Inspection и data tools доступны во всех состояниях
        analysis.stateCommandMap.disconnected.allowedTools.push(toolName);
        analysis.stateCommandMap.connected.allowedTools.push(toolName);
        analysis.stateCommandMap.debuggerPaused.allowedTools.push(toolName);
      }
    }
  });

  return analysis;
}

// Определение известных доменов CDP
function getKnownDomains() {
  return {
    'Debugger': {
      description: 'Debugger domain exposes JavaScript debugging capabilities',
      commands: {
        'enable': { requiresEnable: false, requiresPause: false, requiresConnection: true },
        'disable': { requiresEnable: false, requiresPause: false, requiresConnection: true },
        'setBreakpointByUrl': { requiresEnable: true, requiresPause: false, requiresConnection: true },
        'removeBreakpoint': { requiresEnable: true, requiresPause: false, requiresConnection: true },
        'resume': { requiresEnable: true, requiresPause: true, requiresConnection: true },
        'pause': { requiresEnable: true, requiresPause: false, requiresConnection: true },
        'stepOver': { requiresEnable: true, requiresPause: true, requiresConnection: true },
        'stepInto': { requiresEnable: true, requiresPause: true, requiresConnection: true },
        'stepOut': { requiresEnable: true, requiresPause: true, requiresConnection: true },
        'evaluateOnCallFrame': { requiresEnable: true, requiresPause: true, requiresConnection: true },
        'getStackTrace': { requiresEnable: true, requiresPause: true, requiresConnection: true }
      },
      events: {
        'paused': {},
        'resumed': {},
        'breakpointResolved': {}
      }
    },
    'Runtime': {
      description: 'Runtime domain exposes JavaScript runtime by means of remote evaluation',
      commands: {
        'enable': { requiresEnable: false, requiresPause: false, requiresConnection: true },
        'disable': { requiresEnable: false, requiresPause: false, requiresConnection: true },
        'evaluate': { requiresEnable: true, requiresPause: false, requiresConnection: true },
        'getProperties': { requiresEnable: true, requiresPause: false, requiresConnection: true }
      },
      events: {
        'consoleAPICalled': {},
        'exceptionThrown': {}
      }
    },
    'Console': {
      description: 'Console domain defines methods and events for interaction with the console',
      commands: {
        'enable': { requiresEnable: false, requiresPause: false, requiresConnection: true },
        'disable': { requiresEnable: false, requiresPause: false, requiresConnection: true }
      },
      events: {
        'messageAdded': {}
      }
    }
  };
}

// Основная функция
async function main() {
  try {
    const analysis = analyzeProtocol();
    
    // Сохранение результатов в TypeScript файл
    const outputPath = resolve(__dirname, '../src/generated/protocol-requirements.ts');
    const tsContent = `// Generated automatically by scripts/analyze-protocol.js
// DO NOT EDIT MANUALLY

export interface ToolRequirement {
  requiresConnection: boolean;
  requiresEnable: boolean;
  requiresPause: boolean;
  domains: string[];
  category: 'connection' | 'disconnection' | 'debugging' | 'inspection' | 'data';
}

export interface StateInfo {
  description: string;
  allowedCategories: string[];
  allowedTools: string[];
  additionalRequirements?: {
    requiresPause?: boolean;
  };
}

export const PROTOCOL_ANALYSIS = ${JSON.stringify(analysis, null, 2)};

export const TOOL_REQUIREMENTS: Record<string, ToolRequirement> = PROTOCOL_ANALYSIS.toolRequirements as Record<string, ToolRequirement>;

export const STATE_COMMAND_MAP: Record<string, StateInfo> = PROTOCOL_ANALYSIS.stateCommandMap as Record<string, StateInfo>;

export function getToolRequirement(toolName: string): ToolRequirement | null {
  return TOOL_REQUIREMENTS[toolName] ?? null;
}

export function isToolAllowedInState(
  toolName: string, 
  state: string, 
  isPaused: boolean = false,
  enabledDomains: string[] = []
): boolean {
  const requirement = getToolRequirement(toolName);
  if (!requirement) {
    return false;
  }

  const stateInfo = STATE_COMMAND_MAP[state];
  if (!stateInfo) {
    return false;
  }

  // Проверяем, разрешен ли инструмент в данном состоянии
  const isAllowed = stateInfo.allowedTools.includes(toolName) || 
                   stateInfo.allowedCategories.includes(requirement.category);

  if (!isAllowed) {
    return false;
  }

  // Дополнительная проверка для инструментов, требующих паузы
  if (requirement.requiresPause && !isPaused) {
    return false;
  }

  // Проверка активации необходимых доменов
  if (requirement.requiresEnable && requirement.domains.length > 0) {
    const hasRequiredDomains = requirement.domains.every(domain => 
      enabledDomains.includes(domain)
    );
    if (!hasRequiredDomains) {
      return false;
    }
  }

  return true;
}

export function getRequiredDomainsForTool(toolName: string): string[] {
  const requirement = getToolRequirement(toolName);
  return requirement?.domains ?? [];
}

export function getToolsForState(
  state: string, 
  isPaused: boolean = false,
  enabledDomains: string[] = []
): string[] {
  const stateInfo = STATE_COMMAND_MAP[state];
  if (!stateInfo) {
    return [];
  }

  return Object.keys(TOOL_REQUIREMENTS).filter(toolName =>
    isToolAllowedInState(toolName, state, isPaused, enabledDomains)
  );
}
`;

    writeFileSync(outputPath, tsContent, 'utf8');
    console.log('Protocol analysis saved to:', outputPath);
    
    // Статистика
    const totalDomains = Object.keys(analysis.domains).length;
    const totalTools = Object.keys(analysis.toolRequirements).length;
    const totalStates = Object.keys(analysis.stateCommandMap).length;
    
    console.log('Analysis Statistics:');
    console.log(`  CDP Domains: ${totalDomains}`);
    console.log(`  MCP Tools: ${totalTools}`);
    console.log(`  Debug States: ${totalStates}`);
    console.log(`  Generated at: ${analysis.generatedAt}`);
    
  } catch (error) {
    console.error('Error during protocol analysis:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { analyzeProtocol };