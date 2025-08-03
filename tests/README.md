# MCP Chrome Debugger Protocol - Test Suite

This directory contains comprehensive integration tests for the MCP Chrome Debugger Protocol server. The tests are built using Jest and simulate real-world usage scenarios as an MCP client.

## Test Architecture

### Test Structure
```
tests/
├── fixtures/
│   └── test-app/           # TypeScript test application
├── utils/                  # Test utilities and helpers
├── integration/            # Integration test suites
└── README.md              # This file
```

### Test Components

1. **Test Application** (`fixtures/test-app/`)
   - TypeScript application that compiles to JavaScript with source maps
   - Includes SIGUSR2 signal handler for testing
   - Contains various code patterns for comprehensive debugging scenarios
   - Simulates real-world Node.js application behavior

2. **MCP Client** (`utils/mcp-client.ts`)
   - Implements MCP client using @modelcontextprotocol/sdk
   - Communicates with the debugger server via stdio
   - Manages server process lifecycle

3. **Test App Manager** (`utils/test-app-manager.ts`)
   - Spawns and manages test application processes
   - Handles debugger port allocation using `get-port`
   - Supports both pre-enabled debugging and runtime debugging via SIGUSR1

4. **Debugger Test Helper** (`utils/debugger-test-helper.ts`)
   - High-level wrapper around MCP debugger tools
   - Provides convenient methods for common debugging operations
   - Handles error scenarios and state management

## Test Suites

### 1. Connection Tests (`integration/connection.test.ts`)
- **connect_default**: Default port (9229) connections
- **connect_url**: WebSocket URL connections
- **enable_debugger_pid**: Runtime debugger enabling via SIGUSR1
- **disconnect**: Connection cleanup
- Error handling and reconnection scenarios

### 2. Script Management Tests (`integration/scripts.test.ts`)
- **list_scripts**: Script enumeration
- **find_script_by_url**: Script lookup with regex patterns
- **get_script_source**: Source code retrieval with source maps
- **search_scripts**: Code pattern searching across scripts
- Performance and metadata validation

### 3. Breakpoint Tests (`integration/breakpoints.test.ts`)
- **set_breakpoint**: Basic and conditional breakpoints
- **set_logpoint**: Logpoints with expression interpolation
- **remove_breakpoint**: Breakpoint cleanup
- Multiple breakpoint management
- Breakpoint behavior during execution

### 4. Execution Control Tests (`integration/execution.test.ts`)
- **pause**: Execution pausing
- **resume**: Execution resumption
- **step_over**: Line-by-line stepping
- **step_into**: Function call stepping
- **step_out**: Function exit stepping
- Complex scenarios (loops, async operations, nested calls)

### 5. Evaluation Tests (`integration/evaluation.test.ts`)
- **evaluate**: Expression evaluation in various contexts
- **get_call_stack**: Call stack inspection
- **get_scope_variables**: Variable inspection by scope
- Context-aware evaluation (this, local variables, call frames)
- Error handling for invalid expressions

## Running Tests

### Prerequisites
```bash
# Install dependencies
npm install

# Build the main project
npm run build
```

### Test Execution
```bash
# Run all integration tests
npm run test:integration

# Run tests in watch mode
npm run test:integration:watch

# Run specific test suite
npm run test:integration -- --testPathPattern=connection

# Run with verbose output
npm run test:integration -- --verbose

# Run with coverage
npm run test:integration -- --coverage
```

### Test Configuration
The integration tests use a separate Jest configuration (`jest.config.integration.js`) with:
- 30-second test timeout (debugging operations can be slow)
- Global setup/teardown for project building
- Maximum 4 workers for parallel execution
- TypeScript support via ts-jest

## Key Features

### Port Management
- Uses `get-port` to find free ports automatically
- Prevents port conflicts during parallel test execution
- Supports both pre-allocated and runtime port assignment

### Process Management
- Proper process lifecycle management with cleanup
- Signal handling (SIGUSR1 for debugging, SIGUSR2 for testing)
- Graceful shutdown with fallback to SIGKILL

### Source Map Support
- Test application compiles TypeScript to JavaScript with source maps
- Enables debugging of original TypeScript code
- Tests verify source map functionality

### Error Resilience
- Comprehensive error handling in all test scenarios
- Cleanup in beforeEach/afterEach hooks
- Graceful handling of debugger connection failures

### Real-world Simulation
- Tests complex debugging scenarios (recursion, async operations, loops)
- Validates behavior under various execution states
- Tests performance characteristics

## Test Data and Scenarios

The test application (`fixtures/test-app/src/index.ts`) includes:
- **Class methods**: DataProcessor with various operations
- **Async operations**: Promise-based operations with delays
- **Recursive functions**: Fibonacci and factorial calculations
- **Loops and iterations**: Data processing loops
- **Signal handlers**: SIGUSR1/SIGUSR2 handling
- **Console logging**: Various log statements for logpoint testing
- **Error conditions**: Scenarios that can trigger debugging

## Debugging the Tests

To debug failing tests:

1. **Enable verbose logging**:
   ```bash
   npm run test:integration -- --verbose --no-cache
   ```

2. **Run single test**:
   ```bash
   npm run test:integration -- --testNamePattern="should connect to default"
   ```

3. **Inspect test application**:
   ```bash
   cd tests/fixtures/test-app
   npm run build
   node --inspect dist/index.js
   ```

4. **Manual MCP server testing**:
   ```bash
   npm run build
   node dist/index.js
   ```

## Contributing

When adding new tests:
1. Follow the existing test structure and naming conventions
2. Use the helper utilities for common operations
3. Ensure proper cleanup in afterEach hooks
4. Add timeout handling for long-running operations
5. Test both success and error scenarios
6. Document any new test utilities or patterns

## Troubleshooting

### Common Issues

1. **Port conflicts**: Tests automatically find free ports, but manual processes might conflict
2. **Process cleanup**: Ensure test applications are properly terminated
3. **Build issues**: The test setup automatically builds both main project and test app
4. **Timeout errors**: Increase timeout for slow systems or add more wait time
5. **Permission errors**: Ensure Node.js can send signals to spawned processes

### Performance Considerations

- Tests run with a 30-second timeout by default
- Parallel execution is limited to 4 workers
- Each test spawns fresh processes for isolation
- Build steps are cached between test runs