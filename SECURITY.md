# Security

VestLens holds read access to a brokerage account, so security reports matter.

## Reporting a vulnerability

Please report it privately through GitHub's private vulnerability reporting: open the **Security** tab of the
repository and choose **Report a vulnerability**. Please do not open a public issue or pull request for a
vulnerability, and do not include real account data, keys or tokens in a report.

This is a small, volunteer-run project. I will acknowledge a report as soon as I can, but I cannot promise a fixed
response time.

## Scope

In scope: the code in this repository (sign-in, sessions, the MCP gateway, the API, the Docker setup).

Out of scope: vulnerabilities in SnapTrade, your brokerage, Docker, PostgreSQL or your hosting provider (report those
to them), and a deployment that has been misconfigured against the README (for example, a weak password, or exposing
a plain-http instance to an untrusted network).

## Operating it safely

- Keep the owner password in a password manager. Anyone with it can read your portfolio through your instance.
- Keep `.env` private (it is created with mode 0600) and never commit it.
- Use https for anything beyond your own machine, and run a single instance.
