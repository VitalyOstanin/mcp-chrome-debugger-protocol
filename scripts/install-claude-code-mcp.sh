#!/bin/bash

# Script to install MCP Chrome Debugger Protocol server via Claude MCP CLI

echo "=== Installing MCP Chrome Debugger Protocol Server ==="

# Check if claude command is available
if ! command -v claude &> /dev/null; then
    echo "Error: Claude CLI is not installed or not in PATH"
    echo "Please install Claude CLI first: https://docs.anthropic.com/en/docs/claude-code"
    exit 1
fi

echo "Adding MCP Chrome Debugger Protocol server to Claude MCP configuration..."

# Add the MCP server using Claude CLI
claude mcp add chrome-debugger-protocol npx @vitalyostanin/mcp-chrome-debugger-protocol --scope user

if [ $? -eq 0 ]; then
    echo "Successfully added MCP Chrome Debugger Protocol server for Claude Code"
    echo ""
    echo "The server is now available with the following tools:"
    echo "- attach: Attach to debugger (by URL/PID or default port)"
    echo "- disconnect: Disconnect from current debugger session"
    echo "- setBreakpoints: Set breakpoints/logpoints"
    echo "- removeBreakpoint: Remove breakpoints"
    echo "- continue, pause, next, stepIn, stepOut"
    echo "- evaluate, stackTrace, variables, scopes"
    echo "- getLogpointHits / clearLogpointHits"
    echo "- getDebuggerEvents / clearDebuggerEvents"
    echo "- getDebuggerState"
    echo "- resolveOriginalPosition / resolveGeneratedPosition"
    echo ""
    echo "Usage examples:"
    echo "1. Start your Node.js app with debugger: node --inspect your-app.js"
    echo "2. In Claude Code, use: attach"
    echo "3. Set breakpoints, evaluate expressions, and debug"
else
    echo "Failed to add MCP server. Please check the error above."
    exit 1
fi
