# Contributing

Thanks for helping. Requirements: Node 22+.

```
npm ci
npm run typecheck
npm test
```

- TypeScript, no framework. Library files import siblings with a `.ts` extension; files under `api/` import `../lib/x.js`.
- Tests use `node:test` and may mock `fetch`; the product code path must stay real (no mocked repro).
- Keep commits small with a real message. Never commit secrets (`gitleaks` runs in CI).
