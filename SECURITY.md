# Security

OpenApplyr holds API keys, mailbox access and personal data, so security reports matter a lot to us.

## Reporting a vulnerability

Use **Report a vulnerability** on the repository's Security tab (GitHub private vulnerability reporting). Please do not open a public issue.

Include what an attacker can do, the steps to reproduce it, and the version or commit. We will confirm receipt, keep you informed while it is fixed, and credit you in the release notes unless you prefer not to be named.

## What is in scope

- A posting, email or web page that runs script in the interface, or makes the apply agent act on its instructions (submit, navigate off the allowlist, send email, reveal data).
- Secrets (API keys, mail passwords or tokens, site passwords) readable outside the encrypted store, or written to logs.
- The interface reaching Node, the file system or the network directly.
- An application or email sent without the approval the user's settings require.
- Data sent somewhere other than what the README's "What leaves your computer" section lists.

Out of scope: attacks that need malware already running as the user, and weaknesses in job sites or email providers themselves.

## Supported versions

Fixes go into the latest release.
