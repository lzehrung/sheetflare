# Security Policy

## Scope

Sheetflare is a self-hosted gateway that handles:

- Google service-account credentials
- admin bearer tokens and scoped API keys
- cached copies of spreadsheet data

Treat security issues in auth, credential handling, cache isolation, admin access, and data exposure as high priority.

## Reporting

Please do not open public GitHub issues for suspected security vulnerabilities.

Instead, email:

- `me@lukezehrung.com`

Include:

- affected version or commit
- reproduction steps
- expected impact
- any proof-of-concept details needed to validate the issue

You should receive an acknowledgement within 5 business days.

## Disclosure

- We prefer coordinated disclosure.
- After a fix is available, we may publish a short advisory or changelog note.
- If the report is not reproducible, we will say so directly and share what we checked.

## Hardening Expectations

If you deploy Sheetflare:

- rotate Google keys and admin credentials per environment
- keep admin access private
- prefer scoped API keys over the bootstrap admin token
- treat direct spreadsheet edits as part of your threat and integrity model
