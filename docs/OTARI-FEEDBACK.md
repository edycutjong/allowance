# What we learned building on Otari

Notes from building [Allowance](../README.md) against `api.otari.ai` during the Devs Wilding hackathon (2026-11-07). Four are real bugs with a repro, the rest are documentation gaps; the last sections answer the hackathon's written-feedback questions from what we built. Request ids are Otari's. Items come from our own API calls and app logs during the build; the status codes for the two request ids tied to issue #1 are visible in that issue's public comments, the raw responses for the rest are not in this repository.

## Bugs

### 1. A guardrail `url` gets `/validate` appended, and the failure is opaque

Repro: set `guardrails: [{ profile: "prompt-injection", mode: "block", url: "https://host/api/guard/<token>/validate" }]` on `POST /chat/completions`.
Observed: `502`, "guardrail profile could not be evaluated", `Otari-Guardrails: status=unavailable reason=evaluation_failed`. Otari had called `…/validate/validate`, which returned 404.
Expected: the docs show only the service contract, not that `url` is a base. Surface the upstream status (for example `reason=http_404`).
Also: with no `url`, the hosted gateway answers 502 "no guardrails service is configured. Set OTARI_GUARDRAILS_URL…" (request `e8a865df-…`), which tells a hosted user to set a gateway variable they cannot set.

### 2. `max_tool_iterations` is a hard 422 and the request is still billed

Repro: `chat/completions` with `tools`, `mcp_server_ids` and `max_tool_iterations: 6` on a task that needs more rounds.
Observed: `422 "Exceeded max_tool_iterations=6"`, partial work lost, request `eaad9ab3-9770-4f84-b47b-16135c42b6e6` was still billed, no `Otari-Error-Code`.
Expected: the MCP docs say the last allowed round offers no Otari tools and makes the model answer.

### 3. MCP embedded-resource text is not passed to the model

Repro: `mcp_server_ids` with the GitHub MCP server, call `get_file_contents` on a text file.
Observed: the tool record says "successfully downloaded text file … [resource uri=repo://…]". Only the URI reaches the model, which then invented the file's contents.
Expected: forward the embedded resource text.

### 4. Bedrock adapter rejects tool results as `toolResult.json`

Repro: policy whose provider is Bedrock Qwen3-Coder 480B, with `tools` and `mcp_server_ids`.
Observed: `400 "The format of the value at messages.N.content.0.toolResult.content.0.json is invalid. Provide a json object"`, request `81916d1b-9ae2-49fd-82e6-956d54b59245`. Intermittent, depends on which tool ran first. The same request works on DeepInfra models. Routing fallback does not catch it (a 400 after a tool call started), and the 400 has no `Otari-Error-Code`.

## Documentation gaps and small papercuts

- **Service key is hidden.** The "Service key" checkbox sits under "Show advanced". We made three ordinary keys first, each answered `403 "requires a service key"`. Keys can only be disabled, not deleted, so wrong ones pile up.
- **"Invalid master key" for ordinary keys.** Several `GET` routes (`/organizations/me/keys`, `/budgets`, `/keys/me`, `/usage/summary`) answer 401 "Invalid master key" to ordinary and service keys. A key cannot read its own budget, ceiling or usage. We can show a daily contributor-spend sum, not the monthly pool.
- **Budget refusal names an internal id.** `403 budget_exceeded scope=user` reports `eu_…` instead of the external id the caller sent. The message otherwise is excellent (remaining vs estimate, suggests a lower `max_tokens`).
- **Web tools are off by default on hosted.** `GET /tools` shows `web_fetch` and `web_search` as `workspace_disabled`, contrary to the `web_search_workspace_default` doc. Needs "Allow in Default workspace".
- **The sandbox is an IPython kernel.** `sys.exit(3)` comes back as exit code 1, and tracebacks arrive in `stderr` with an IPython header. Fine for pass/fail, wrong for tools that read specific codes. Probe request `7e3c139f-a519-447a-ac41-00f69a9d46df`. A failed run can also return no exit code and empty output, which gives the caller nothing to act on. Whether a 5xx means "the code did not run" (retry safety, double billing) is undocumented.
- **Which text does the guardrail see?** The docs do not say what Otari sends as `input_text`, or whether tool results inside the tool loop are screened. We windowed the guard input ourselves and cannot screen tool output. A guardrail stage on tool results would close this.
- **Images and routing.** On a screenshot report the policy's first target, a text coder, accepted the image without error, so the Qwen3-VL step never ran. Nothing in the response says whether the image was read or dropped. An "images unsupported" error or an `image dropped` header would make fallback predictable (requests `f6141c22-6f01-4831-81dc-8082485ca781`, `eb483b82-0440-465b-9777-2c7fd41dd5b7`).
- **End-user spend can pass the daily budget.** On 2026-11-07, before the 00:00 UTC reset, three end users on our $0.05 `contributor-allowance` budget stood at $0.0512, $0.0526 and $0.0606 (`GET /end-users`, `spend` field). The overshoot is small, but a per-user cap that a user can exceed by 21% needs a documented rule (pre-request estimate? reservation?).
- Key prefix is `otk_` where the docs say `tk_`.

## What worked well

The `Otari-End-User-Budget` header and `GET /end-users`; `402 insufficient_funds` before credit; a sandbox with network that can `pip install` from git; and a guardrail contract simple enough to back with an open-weight model in an afternoon.

## Where calling the provider directly would have been easier

- The Bedrock adapter's `toolResult` 400 (bug 4): it fails mid tool loop, routing does not fall back, and the same request works on DeepInfra. We moved Bedrock out of the primary slot for tool-using requests.
- The guardrail `url` that gets `/validate` appended (bug 1): an opaque 502 with no upstream status.
- `max_tool_iterations` (bug 2): a hard 422 that loses the partial work and is still billed.

## What we built ourselves that Otari could do

- **A guardrail service.** Hosted Otari has no guardrail service configured, so `api/guard` implements the `/validate` contract with Qwen3Guard-Gen-8B, called through Otari.
- **Budget read-back.** A key cannot read its own budget, ceiling or usage (401 "Invalid master key"), so the footer's pool line sums `GET /end-users` and shows the ceiling from our own setting.
- **Guard input limits.** Our guard reads long input in overlapping windows and refuses input past four of them, and the sandbox error quoted back to the model in a repair turn is clipped to its last line, at most 300 characters: a probe (`194e59da-d5ea-4835-8366-be476338d2f9`) showed Qwen3Guard passing #5's injection text once it was quoted inside a `ModuleNotFoundError`. Tool results inside Otari's tool loop are not screened at all.
- **The verdict gate.** The model writes with no code tool; Allowance runs the script with `POST /code/execute` and checks its shape first, so the model cannot grade its own test.
