#!/bin/bash

# Script to remove MCP Chrome Debugger Protocol server via Claude MCP CLI

echo "=== Removing MCP Chrome Debugger Protocol Server ==="

# Check if claude command is available
if ! command -v claude &> /dev/null; then
    echo "Error: Claude CLI is not installed or not in PATH"
    echo "Please install Claude CLI first: https://docs.anthropic.com/en/docs/claude-code"
    exit 1
fi

echo "Removing MCP Chrome Debugger Protocol server from Claude MCP configuration..."

# Remove the MCP server using Claude CLI
claude mcp remove chrome-debugger-protocol --scope user

if [ $? -eq 0 ]; then
    echo "Successfully removed MCP Chrome Debugger Protocol server from Claude Code"
    echo ""
    echo "The chrome-debugger-protocol MCP server has been removed from your configuration."
    echo "You can reinstall it anytime using: ./scripts/install-claude-code-mcp.sh"
else
    echo "Failed to remove MCP server. Please check the error above."
    echo "You can also manually remove it by editing your MCP configuration file."
    exit 1
fi