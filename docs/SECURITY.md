# Security Model

This document describes the trust boundaries, threat model, and operational guidance for `mcp-chrome-debugger-protocol`.

## Table of Contents

- [Intended Use](#intended-use)
- [Trust Boundaries](#trust-boundaries)
- [Threat Model](#threat-model)
  - [Assets](#assets)
  - [Attacker Model](#attacker-model)
  - [Capabilities Granted to a Connected MCP Client](#capabilities-granted-to-a-connected-mcp-client)
  - [Out of Scope](#out-of-scope)
- [Mitigations and Defaults](#mitigations-and-defaults)
- [Operational Guidance](#operational-guidance)
- [Known Limitations / Accepted Risks](#known-limitations--accepted-risks)
- [Reporting a Vulnerability](#reporting-a-vulnerability)

## Intended Use

The server is intended to be run **on a developer workstation** (or an equivalent single-tenant CI sandbox) to debug a Node.js process owned by the same user. It is **not** designed to:

- Sit behind a public proxy.
- Be shared between mutually-distrusting MCP clients on the same machine.
- Attach to a Node.js process owned by another user, or to one running untrusted third-party code.

If your use case violates any of the above, **stop and reconsider**. The capabilities listed below are inherent to the Chrome DevTools / Node Inspector protocol and cannot be sandboxed away.

## Trust Boundaries

```
+-----------------+        stdio (MCP)        +---------------------+   WebSocket (CDP)   +-----------------+
|  MCP client     | <-----------------------> |  MCP server (this)  | <-----------------> |  debuggee       |
|  (LLM agent /   |    JSON-RPC over stdio    |  Node.js process    |   ws://127.0.0.1    |  node --inspect |
|  IDE plugin)    |                           |                     |                     |                 |
+-----------------+                           +---------------------+                     +-----------------+
        ^                                                                                          ^
        |  trusted (same user, same machine)                                trusted (same user)    |
        +------------------------------------------------------------------------------------------+
```

All three components are assumed to belong to the same security principal. There is no authentication between them — the CDP endpoint (`/json/list`, `ws://127.0.0.1:9229`) is unauthenticated by design in Node.js, and the MCP transport is stdio (no network).

## Threat Model

### Assets

| Asset                           | Description                                                                              |
|---------------------------------|------------------------------------------------------------------------------------------|
| Debuggee process memory         | All in-process state, including secrets, tokens, in-memory PII.                          |
| Debuggee code execution context | The ability to run arbitrary JavaScript in the debuggee.                                 |
| Logpoint / event buffers        | Up to 10 000 buffered logpoint hits and debugger events, returned on demand.             |
| Host filesystem (via debuggee)  | The debuggee can `require('fs')` — anything it can read or write becomes reachable.      |

### Attacker Model

The server treats the **MCP client as fully trusted**. The interesting attacker scenarios are:

1. **Untrusted MCP client** (e.g., a remote LLM agent invoked over a network) — *out of scope*. The MCP transport is stdio; if you bridge it to a network, you must impose authentication, authorization, and input filtering yourself.
2. **Compromised debuggee** — a debuggee process that has already been compromised can exfiltrate data through the inspector regardless of whether this server is attached. This is an inherent property of `node --inspect`.
3. **Local unprivileged process probing port 9229** — addressed in [Mitigations](#mitigations-and-defaults): inspector listens on loopback by default.

### Capabilities Granted to a Connected MCP Client

Once an MCP client is connected to a running server **and** the server is attached to a debuggee, the client can:

- **Execute arbitrary JavaScript** in the debuggee via:
  - The `evaluate` tool (direct REPL).
  - The `condition` field on `setBreakpoints` (evaluated each time the line is reached).
  - The `{expr}` placeholders inside logpoint `logMessage` (evaluated each time the line is reached).
- **Read and modify** any variable in any stack frame via `setVariable` / `variables` / `scopes`.
- **Pause, resume, step, restart frames**, and inspect the entire call stack.
- **Enumerate loaded sources** and read their text via CDP.
- **Buffer and retrieve** up to 10 000 logpoint hits — anything `{expr}` evaluates to, including secrets if logpoints reference them.

In short: a connected MCP client is effectively root inside the target Node.js process. Treat the MCP client identity as equivalent to the debuggee's identity.

### Out of Scope

- Network-level threats (TLS, mutual auth, rate limiting). The server uses stdio for MCP and loopback WebSocket for CDP.
- Sandboxing the debuggee. If you need that, run the debuggee under a separate user, container, or VM and do not attach this server across the boundary.
- Protecting against an attacker who already has code execution as the same user as the server.

## Mitigations and Defaults

| Concern                          | Default behavior                                                                                                          | Override                              |
|----------------------------------|---------------------------------------------------------------------------------------------------------------------------|---------------------------------------|
| Remote inspector hosts           | `attach` refuses non-loopback hostnames.                                                                                  | `MCP_CDP_ALLOW_REMOTE=1` (do not use unless you control both ends and have a reason). |
| Logpoint buffer growth           | FIFO ring buffer, capacity 10 000 entries.                                                                                | None (compile-time constant).         |
| Logpoint expression injection    | `{expr}` placeholders are substituted into a `console.log(...)` template and sent verbatim to CDP.                        | None — treat `{expr}` as code, not data. |
| Verbose diagnostics              | Off by default.                                                                                                           | `DAP_VERBOSE=1` enables CDP traffic logs (may include sensitive payloads). |
| MCP transport                    | stdio only. No TCP/HTTP listener.                                                                                         | Do not bridge stdio to a network without auth. |

## Operational Guidance

- **Inspector binding.** `node --inspect` binds to `127.0.0.1` by default since Node 7. **Never** start the debuggee with `--inspect=0.0.0.0` on a multi-tenant or network-exposed host: V8's `Runtime.evaluate` is unauthenticated arbitrary code execution and anyone who can reach the port wins.
- **Remote debugging.** Tunnel over SSH (`ssh -L 9229:127.0.0.1:9229 host`) instead of opening port 9229.
- **Logpoints and secrets.** Do not place logpoints whose `{expr}` references secrets, tokens, or PII in long-lived debug sessions. A later `getLogpointHits` returns them until the buffer is cleared or evicted FIFO.
- **Verbose mode.** `DAP_VERBOSE=1` logs the raw `logMessage` template and CDP traffic; keep it off in shared terminals or shared logs.
- **Process selection.** When using PID-based attach, the server signals the target with `SIGUSR1`. Verify the PID belongs to a Node.js process you own before attaching — `kill -USR1` to an unrelated daemon (e.g., `sshd`, `docker`, `logrotate`-aware services) can trigger unintended behavior in those processes.

## Known Limitations / Accepted Risks

- **Tools `evaluate`, `setBreakpoints` (with `condition` or logpoint `{expr}`) are by-design arbitrary code execution.** This is the entire point of a debugger and is not a bug.
- **No authentication on the CDP WebSocket.** Inherent to Node Inspector. Mitigated only by loopback binding.
- **No authentication on MCP stdio.** Inherent to MCP stdio transport. Mitigated by running server and client as the same user.
- **Logpoint / event buffers are not persisted but are not redacted.** They can grow up to ~10 000 entries; if `{expr}` evaluates to PII, that PII sits in process memory until eviction.
- **Transitive npm advisories.** Tracked in `package-lock.json`; see `npm audit`. Direct dependencies are kept current; transitive findings (currently `hono` via `@modelcontextprotocol/sdk`) are addressed when upstream publishes a fix.

## Reporting a Vulnerability

If you believe you have found a security issue, please **do not** open a public GitHub issue. Instead:

- Email <vitaly.ostanin@gmail.com> with a description and reproduction steps.
- Allow a reasonable amount of time for triage before public disclosure.

For non-security bugs, open an issue at <https://github.com/VitalyOstanin/mcp-chrome-debugger-protocol/issues>.
