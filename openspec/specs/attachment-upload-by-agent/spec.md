# attachment-upload-by-agent Specification

## Purpose
TBD - created by archiving change v06-roadmap. Update Purpose after archive.
## Requirements
### Requirement: Agent uploads are equivalent to human uploads for storage and delivery

Files uploaded via `post_file` SHALL land on disk at the same path shape as human uploads (`<attachments_dir>/<id>.<ext>`), with the same `0600` permissions, the same CSP + `nosniff` serve headers, and the same URL format (`/image/<id>.<ext>`). The `agentEntry()` URL→path rewrite SHALL apply so recipient agents receive the absolute file path via `[attachment: <path>]` in their bridge delivery, identical to human-uploaded attachments.

#### Scenario: Recipient agent sees the same delivery shape

- **WHEN** agent A uploads `diff.md` via `post_file({to: "B", caption: "please review"})`
- **THEN** agent B receives a `wake` delivery whose body is `please review`
- **AND** the appended suffix reads `[attachment: <absolute path>]` pointing to the file on the hub's disk

### Requirement: The existing `/upload` route accepts agent bearer tokens

The hub's `/upload` route SHALL authenticate the same bearer token whether it originates from the webview or from an agent's channel sidecar. No new route is added for agent uploads.

#### Scenario: Same token works from both clients

- **GIVEN** a running hub with `CUBILOT_TOKEN=abc`
- **WHEN** the webview POSTs to `/upload` with `Authorization: Bearer abc`
- **THEN** the upload succeeds
- **WHEN** a channel-mode sidecar POSTs to `/upload` with `Authorization: Bearer abc`
- **THEN** the upload also succeeds with the same response shape

### Requirement: Agents can upload attachments via the `post_file` bridge tool

The bridge SHALL expose a tool named `post_file`, on every runtime, that accepts a local filesystem path on the agent's machine, uploads the bytes to the hub's `/upload` endpoint using the agent's bearer token, and posts the resulting URL as a chat message via `/post`. The tool parameters SHALL be: `path` (required, absolute path on the agent's filesystem), `to` (optional, defaults to `"all"`), and `caption` (optional, free text sent as the message body). The upload SHALL go through the runtime's `Host.upload`; the bearer token SHALL NOT appear in any process argument vector.

The tool implementation SHALL reuse the existing `/upload` route without changes to the route's request shape — the agent's upload is indistinguishable at the route boundary from a human upload. All existing safety rules apply: extension allowlist from `config.yml`, 8 MiB size cap (checked before reading the file), filename-based extension detection.

#### Scenario: Agent uploads a PDF and posts it

- **GIVEN** `config.yml` includes `pdf` in `attachment_extensions`
- **AND** an agent has a file at `/tmp/report.pdf` within its reachable filesystem
- **WHEN** the agent calls `post_file({path: "/tmp/report.pdf", to: "human", caption: "Q4 summary"})`
- **THEN** the hub stores the file at `<attachments_dir>/<id>.pdf` with mode `0600`
- **AND** a chat card appears in the UI with the agent as sender, "Q4 summary" as the body, and the PDF as an inline attachment
- **AND** other agents in the target list receive the same entry through their bridge

#### Scenario: Disallowed extension is rejected at upload time

- **GIVEN** `config.yml` has `attachment_extensions: ["jpg","png"]`
- **WHEN** an agent calls `post_file({path: "/tmp/notes.md", to: "all"})`
- **THEN** the `/upload` call returns HTTP 400 with `"extension 'md' not in allowlist (...)"`
- **AND** the tool call fails with that error message so the agent can recover
- **AND** no chat entry is created

#### Scenario: Missing or unreadable path surfaces a clear error

- **WHEN** the agent calls `post_file({path: "/nonexistent.pdf", to: "human"})`
- **THEN** the tool fails with an error describing the read failure
- **AND** no HTTP call to the hub is made

