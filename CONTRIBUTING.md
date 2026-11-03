# Contributing

Shot Workbench is an early local-first application. Small fixes, usability improvements, accessibility and documentation contributions are welcome.

## Get started

1. Use Node.js 24 or newer.
2. Clone the repository and create a branch.
3. Run `npm start` and open the printed local URL.
4. Run `npm test` before submitting a pull request.

No dependency installation is required. Browser smoke testing is optional; see the README for the installed-Chrome requirement.

## Design constraints

- Keep the basic workflow usable offline, without accounts or model APIs.
- Keep draft prompts separate from immutable take snapshots.
- Preserve stale-write protection and media byte-range support.
- Store runtime records and media outside tracked source. Never commit data, backups, real prompts, customer media, credentials or machine-specific paths.
- Do not introduce media deletion without updating the append-only backup contract and restore tests.
- Describe database migration and backup implications when changing storage.

For larger changes, open an issue with the concrete workflow and expected behavior first. Pull requests should explain the change, how it was checked and any remaining limitations. Use synthetic fixtures and include screenshots for visible UI changes where practical.

By contributing, you agree that your contribution can be distributed under this repository's MIT License. Include attribution and compatible licensing for any third-party material you introduce.
