# Security Policy

## Operator Responsibility

Sheetflare is designed for controlled self-hosted deployments. You are responsible for safe operation, including credential hygiene, access controls, and backups/recovery.

## Scope

Sheetflare is a self-hosted gateway that handles:

- Google service-account credentials
- admin bearer tokens and scoped API keys
- cached copies of spreadsheet data

Treat security issues in auth, credential handling, cache isolation, admin access, and data exposure as high priority.

## Reporting

Please do not open public GitHub issues for suspected security vulnerabilities.

If you choose to report an issue, you can email:

- `me@lukezehrung.com`

Include:

- affected version or commit
- reproduction steps
- expected impact
- any proof-of-concept details needed to validate the issue

There is **no guaranteed response, fix, or timeline**.

## Disclosure

- If we engage on a report, we prefer coordinated disclosure.
- If a fix is available, we may publish a short advisory or changelog note.

## Hardening Expectations

If you deploy Sheetflare:

- rotate Google keys and admin credentials per environment
- keep admin access private
- prefer scoped API keys over the bootstrap admin token
- treat direct spreadsheet edits as part of your threat and integrity model
