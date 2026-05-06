#!/bin/bash
set -euo pipefail

# Script for testing MCP server in dev mode

echo "=== MCP Node.js Debugger - Dev Test ==="

# Check if dependencies are installed
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

# Build project
echo "Building project..."
if ! npm run build; then
    echo "Build failed!" >&2
    exit 1
fi

echo "Build successful!"

# Build test application
echo "Building test application..."
(
    cd tests/fixtures/test-app
    npm install --silent
    npm run build --silent
)

echo "Starting HTTP test server with debugger..."
node --inspect tests/fixtures/test-app/dist/index.js &
TEST_PID=$!
echo "Test HTTP server started with PID: $TEST_PID"

echo "Debugger should be available on ws://127.0.0.1:9229"

# Wait until the inspector accepts requests; bounded loop instead of a fixed sleep.
INSPECTOR_READY=0
for _ in $(seq 1 20); do
    if curl -sf http://127.0.0.1:9229/json/version >/dev/null 2>&1; then
        INSPECTOR_READY=1
        break
    fi
    sleep 0.5
done

if [ "$INSPECTOR_READY" -ne 1 ]; then
    echo "Warning: inspector did not respond on 9229 within 10s" >&2
fi

echo ""
echo "HTTP server is running with debugger enabled!"
echo "Server endpoints:"
echo "- GET http://localhost:3000/test1 (calls fibonacci and breakpoint functions)"
echo "- GET http://localhost:3000/test2 (calls async and recursive functions)" 
echo "- GET http://localhost:3000/health (server status)"
echo ""
echo "Now you can:"
echo "1. Run MCP server: npm run start"
echo "2. Use Claude Code to connect with tool: attach"
echo "3. Set breakpoints and debug by triggering HTTP requests"
echo "4. Try conditional breakpoints and logpoints"
echo ""
echo "Available MCP tools:"
echo "- attach: Attach to debugger" 
echo "- setBreakpoints: Set breakpoint/logpoint (with optional condition/logMessage)"
echo "- evaluate: Execute JavaScript expressions"
echo ""
echo "To stop test app: kill $TEST_PID"
echo "Press Ctrl+C to stop this script and test app"

# Wait for signal to stop
trap "echo 'Stopping test app...'; kill $TEST_PID 2>/dev/null; exit 0" SIGINT SIGTERM

wait $TEST_PID
