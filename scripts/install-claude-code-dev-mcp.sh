#!/bin/bash

# Script to install MCP Chrome Debugger Protocol server in development mode

echo "=== Installing MCP Chrome Debugger Protocol Server (Development Mode) ==="

# Check if claude command is available
if ! command -v claude &> /dev/null; then
    echo "Error: Claude CLI is not installed or not in PATH"
    echo "Please install Claude CLI first: https://docs.anthropic.com/en/docs/claude-code"
    exit 1
fi

# Get the absolute path to the project
PROJECT_PATH=$(pwd)
DIST_PATH="$PROJECT_PATH/dist/index.js"

# Check if dist/index.js exists
if [ ! -f "$DIST_PATH" ]; then
    echo "Building project first..."
    npm run build

    if [ ! -f "$DIST_PATH" ]; then
        echo "Build failed or dist/index.js not found"
        echo "Please run 'npm run build' first"
        exit 1
    fi
fi

echo "Adding MCP Chrome Debugger Protocol server (development mode) to Claude MCP configuration..."
echo "Using path: $DIST_PATH"

# Add the MCP server using Claude CLI with local path
claude mcp add chrome-debugger-protocol node "$DIST_PATH" --scope user

if [ $? -eq 0 ]; then
    echo "Successfully added MCP Chrome Debugger Protocol server in development mode for Claude Code"
    echo ""
    echo "Development mode features:"
    echo "- Uses local build from: $DIST_PATH"
    echo "- Changes take effect after rebuilding: npm run build"
    echo "- Useful for testing and development"
    echo ""
    echo "Available tools:"
    echo "- connect_default: Connect to debugger on port 9229"
    echo "- connect_url: Connect via WebSocket URL"
    echo "- enable_debugger_pid: Enable debugger via SIGUSR1"
    echo "- disconnect: Disconnect from current debugger session"
    echo "- list_scripts: List loaded scripts"
    echo "- set_breakpoint: Set breakpoints (with conditions)"
    echo "- set_logpoint: Set logpoints with custom messages"
    echo "- find_script_by_url: Find scripts by URL pattern"
    echo "- remove_breakpoint: Remove breakpoints"
    echo "- resume: Resume execution"
    echo "- pause: Pause execution"
    echo "- step_over: Step over to next line"
    echo "- step_into: Step into function call"
    echo "- step_out: Step out of current function"
    echo "- evaluate: Execute JavaScript expressions"
    echo "- get_call_stack: Get current call stack"
    echo "- get_scope_variables: Get variables in scope"
    echo "- get_script_source: Get source code for scripts"
    echo "- search_scripts: Search for code patterns across scripts"
    echo ""
    echo "To test:"
    echo "1. Run: npm run dev:test"
    echo "2. In Claude Code, use: connect_default"
    echo ""
    echo "To switch to production mode, run: ./scripts/install-claude-code-mcp.sh"
else
    echo "Failed to add MCP server. Please check the error above."
    exit 1
fi
