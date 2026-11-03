# Security scope

The supported deployment is a single-user service bound to `127.0.0.1`. The application has no user accounts or network authentication. Do not change the bind address or expose it through a public reverse proxy without adding and reviewing access control.

Mutating requests require a local application header. Host and Origin checks reject unintended browser origins. Media is served through database IDs, static files are explicitly allowlisted and a Content Security Policy limits active content.

## Reporting

Use the repository's private vulnerability reporting feature if the maintainer has enabled it. Otherwise, open a minimal issue asking for a private reporting channel. Do not publish exploit details, credentials or private media in a public issue.

Only the current `0.1.x` line is maintained at this stage. A full security audit has not been performed.
