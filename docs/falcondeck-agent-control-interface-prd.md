# Product Requirements Document: FalconDeck Agent Control Interface

**Status:** Draft  
**Initial release:** Scheduled automations and core settings  
**Product:** FalconDeck

## 1. Summary

FalconDeck will provide a built-in Model Context Protocol (MCP) interface that lets users inspect, configure and operate FalconDeck through any supported agent harness, including Codex, Claude and future Agent Client Protocol (ACP) providers.

Users should be able to ask their agent to perform actions such as creating a scheduled automation, changing harness defaults or inspecting workspace settings without leaving the conversation. The MCP interface will be enabled by default and may be disabled globally or for individual harnesses.

The first release will support scheduled automations and a limited set of core FalconDeck settings while establishing an extensible architecture for broader conversational control.

## 2. Problem

FalconDeck settings and operational controls are primarily accessed through its graphical interface. In an agent-first workflow, users expect to manage the system conversationally from whichever harness they are using.

Exposing every setting or action as a separate MCP tool would create a large, token-heavy tool catalogue that becomes difficult to maintain. Relying on injected skill instructions alone would be unreliable, insufficiently typed and prone to documentation drift.

## 3. Goals

- Allow agents to discover FalconDeck capabilities progressively.
- Provide conversational access to supported FalconDeck settings and operations.
- Keep the initial MCP tool surface small and token-efficient.
- Use the same underlying control service for the graphical interface and MCP.
- Work consistently across Codex, Claude and ACP-compatible harnesses.
- Return validated, structured and concise results.
- Establish a foundation that can eventually cover most graphical-interface functionality.

## 4. Non-goals

- Exposing every internal daemon method directly.
- Allowing arbitrary code execution through the MCP server.
- Replacing the FalconDeck graphical settings interface.
- Supporting every FalconDeck setting in the first release.
- Creating a separate permissions or identity system for MCP operations.

## 5. User stories

- As a user, I can ask an agent to create a recurring, one-time or conditional automation.
- As a user, I can list, inspect, pause, resume, update, run or delete my automations.
- As a user, I can inspect and change supported FalconDeck or harness settings.
- As a user, I can ask what FalconDeck can configure without loading every available operation into the conversation.
- As a user, I can disable conversational FalconDeck control globally or for a particular harness.

## 6. Proposed experience

Example request:

> Every weekday at 8am, use Codex to review my inbox and surface anything requiring attention.

Expected flow:

1. The agent searches FalconDeck's available capabilities.
2. FalconDeck returns the relevant automation operation, input schema and concise guidance.
3. The agent gathers any materially missing information.
4. The agent executes the validated operation.
5. FalconDeck returns the created automation, resolved schedule, timezone, harness and status.

Routine operations should not require an additional FalconDeck confirmation by default. Clients may apply user-configured confirmation policies to destructive or sensitive operations.

## 7. MCP interface

The initial MCP server will expose three tools:

### `falcondeck_search`

Search the capability registry by natural-language query, domain or operation. Results include operation identifiers, descriptions, behavioural metadata, input schemas, examples and related operations.

### `falcondeck_get`

Read current settings, resources and operational state. It must support filtering, field selection and pagination where relevant. This tool is read-only.

### `falcondeck_execute`

Execute a named operation returned by `falcondeck_search`. Arguments are validated against the operation's current schema before execution. The tool does not accept arbitrary code or internal API paths.

## 8. Architecture requirements

- The FalconDeck daemon remains the source of truth.
- A shared internal control service must serve both the graphical interface and MCP adapter.
- A daemon-owned capability registry must define each supported operation's stable identifier, description, scope, input schema, output schema, defaults, constraints and behavioural metadata.
- Supported scopes include global, host, workspace, harness and thread.
- MCP requests must use explicit stable identifiers rather than hidden protocol-session state.
- The integration should support the current production MCP version used by FalconDeck's supported harnesses and be designed for the 28 July 2026 stateless protocol model.
- A minimal injected skill may direct agents to search FalconDeck capabilities before unfamiliar operations, but must not duplicate the capability catalogue.

## 9. Scheduled automation requirements

The first release must support:

- recurring schedules;
- one-time schedules;
- conditional checks;
- explicit timezone handling;
- harness and workspace selection;
- enabled, paused, running, completed and failed states as applicable;
- create, list, inspect, update, pause, resume, run-now and delete operations;
- execution history and latest outcome;
- clear validation for unsupported schedules or missing dependencies.

Automation definitions and execution records must be owned by the daemon, not by an individual harness conversation.

## 10. Safety and reliability

- MCP operations receive the same effective authority as the current FalconDeck user and target context.
- Secrets must be redacted from reads and must not be returned to the model after being stored.
- Inputs and structured outputs must be schema-validated.
- Mutations must be recorded with timestamp, originating harness, thread and user/device context where available.
- Updates should support revision-aware concurrency to prevent silent overwrites.
- Destructive, read-only and idempotent behaviour must be declared in capability metadata.
- Responses must be bounded through concise defaults, pagination, field selection or resource links.
- Errors must explain what failed and what the agent should do next.

## 11. Settings and controls

The feature is enabled by default. Users can:

- disable the FalconDeck MCP interface globally;
- enable or disable it per harness;
- optionally require confirmation for selected operation classes;
- inspect recent MCP-originated changes.

Disabling the interface must remove or prevent access to its tools for affected harnesses.

## 12. Acceptance criteria

- Codex and Claude can create and manage the same automation using the three-tool interface.
- An unfamiliar operation can be completed through progressive discovery without a large injected skill or static tool catalogue.
- Invalid inputs are rejected before state changes occur.
- Changes made through MCP are immediately reflected in the graphical interface, and vice versa.
- Secrets are never exposed through read or mutation responses.
- The interface can be disabled globally and per harness.
- Tool responses remain concise for accounts with large numbers of automations or settings.

## 13. Future scope

Future releases may add comprehensive harness configuration, hosts, workspaces, connectors, pairing, remote-server provisioning and other FalconDeck operations through the same registry and tool interface. Long-running operations may use MCP task semantics where supported.
