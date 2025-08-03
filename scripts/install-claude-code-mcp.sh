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
    echo "Usage examples:"
    echo "1. Start your Node.js app with debugger: node --inspect your-app.js"
    echo "2. In Claude Code, use: connect_default"
    echo "3. Set breakpoints, evaluate expressions, and debug"
else
    echo "Failed to add MCP server. Please check the error above."
    exit 1
fi