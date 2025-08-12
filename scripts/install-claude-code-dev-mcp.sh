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
    echo "- attach: Attach to debugger (default port 9229 or by URL/PID)"
    echo "- disconnect: Disconnect from current debugger session"
    echo "- setBreakpoints: Set breakpoints/logpoints (with conditions/logMessage)"
    echo "- removeBreakpoint: Remove breakpoints"
    echo "- continue: Continue execution"
    echo "- pause: Pause execution"
    echo "- next, stepIn, stepOut: Stepping"
    echo "- evaluate, stackTrace, variables, scopes: Inspection"
    echo "- getLogpointHits / clearLogpointHits"
    echo "- getDebuggerEvents / clearDebuggerEvents"
    echo "- getDebuggerState"
    echo "- resolveOriginalPosition / resolveGeneratedPosition"
    echo ""
    echo "To test:"
    echo "1. Run: npm run dev:test"
    echo "2. In Claude Code, use: attach"
    echo ""
    echo "To switch to production mode, run: ./scripts/install-claude-code-mcp.sh"
else
    echo "Failed to add MCP server. Please check the error above."
    exit 1
fi
