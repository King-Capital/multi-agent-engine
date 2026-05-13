# Security Policy

## Supported Versions

Security fixes are accepted against `main`. Public releases are tagged from the current stable `VERSION`.

## Reporting a Vulnerability

Please do not open a public issue for suspected credential exposure, auth bypass, sandbox escape, SSRF, command execution, or data exfiltration bugs.

Use GitHub private vulnerability reporting if it is enabled for this repository. If it is not available, email the maintainer listed in the repository profile with:

- affected version or commit
- reproduction steps
- expected impact
- any relevant logs with secrets redacted

We will acknowledge valid reports as quickly as possible and coordinate a fix before public disclosure.

## Secrets and Local Infrastructure

MAE should be configured through `.env`, `~/.mae/config`, or environment variables copied from `.env.example`. Do not commit real credentials, private hostnames, private IPs, dashboard tokens, Langfuse keys, LiteLLM keys, A2A tokens, or deployment-specific infrastructure details.
