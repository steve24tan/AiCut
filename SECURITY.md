# Security scope

The supported deployment is a single-user service bound to `127.0.0.1`. The application has no user accounts or network authentication. Do not change the bind address or expose it through a public reverse proxy without adding and reviewing access control.

Mutating requests require a local application header. Host and Origin checks reject unintended browser origins. Media is served through database IDs, static files are explicitly allowlisted and a Content Security Policy limits active content.

## Reporting

Use the repository's private vulnerability reporting feature if the maintainer has enabled it. Otherwise, open a minimal issue asking for a private reporting channel. Do not publish exploit details, credentials or private media in a public issue.

Only the current `0.4.x` line is maintained at this stage. A full security audit has not been performed.

## Optional CLI execution

Native dispatch is an explicit user action. Only installed Claude Code/Codex adapters run, with fixed argument arrays, prompts over stdin and shell disabled. The HTTP API does not accept arbitrary executable paths or shell commands. Adapter-path environment variables are trusted service-startup configuration.

Tasks transmit shot text/metadata to the CLI provider and consume quota. Media bytes are not attached. Claude tools/MCP are disabled for text tasks; Codex runs read-only and ignores user config for this invocation. A task folder is an organizational boundary, not a replacement for the CLI sandbox. Permission-bypass flags are never used.

Native adapters require subscription-style login and remove common API-key environment overrides. Credentials remain owned by the CLIs. Never publish task snapshots, results or diagnostics. SQLite backups preserve task inputs/results; raw task-directory diagnostics are auxiliary and are not included in the standard backup.
