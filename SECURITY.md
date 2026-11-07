# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's
["Report a vulnerability"](../../security/advisories/new) form on this repository. Do not open a public issue.

We aim to acknowledge a report within 3 days.

## Scope notes

- Allowance verifies every GitHub webhook with an HMAC-SHA256 signature check (`X-Hub-Signature-256`) and rejects
  forged requests with 401.
- Untrusted issue text is screened by a guardrail before it reaches the model.
- Reproduction scripts run in the Otari sandbox, never on the host.
- Secrets live in the hosting environment only; none are stored in this repository.
