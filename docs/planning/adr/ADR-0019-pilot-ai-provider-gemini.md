# ADR-0019 — Pilot AI provider: Gemini first, Claude second
- Status: Accepted (owner decision in chat, 2026-11-10) · Date: 2026-11-10

## Context
The planning package named Anthropic Claude as the first `AIProvider` adapter. The owner has a Claude Pro subscription, which does not include API access, and prefers not to open a paid API account for the pilot. The Gemini API has a free tier. T-P0-06 was therefore run on Gemini (`spikes/ai/RESULTS.md`): 24/24 schema-valid structured outputs on two models, verbatim quote grounding 45/45 on `gemini-3.5-flash`, Arabic handled.

## Decision
- The **first `AIProvider` adapter built in P5 is Gemini** (`adapters-ai-gemini`), using `gemini-3.5-flash` for generation tasks and `gemini-3.5-flash-lite` for cheap tasks. Model names live in configuration.
- The **Claude adapter becomes the second adapter**. It is built when an Anthropic API account exists or at P13, whichever comes first.
- Nothing else in ADR-0012 changes: bounded versioned tasks, redaction, budgets, schema validation and quote grounding stay in the AI Gateway and are provider-neutral.
- Where other planning documents say "Claude" for the pilot AI provider, read "the pilot AI provider per this ADR". Claude Code as the developer coding assistant, and the Playwright Test Agents loop in P9, are unaffected.

## Alternatives considered
- **Paid Anthropic API account.** Rejected for now by the owner on cost. It remains the planned second adapter.
- **Local model through the OpenAI-compatible adapter.** No cost and no data leaves the machine, but the 16 GB machine already runs Docker, the parser and browsers, and quality for Arabic is unproven.
- **Defer all AI work.** Rejected: T-P0-06 was the last open spike and Gemini answered it.

## Consequences (positive / negative)
- (+) No API cost during the pilot.
- (+) The provider-agnostic design is exercised from day one with a non-default provider.
- (−) **Privacy:** free-tier content may be used by Google to improve products. Pilot data must be synthetic or personal. Company or confidential data is forbidden on this tier; the redaction step does not make it acceptable.
- (−) **Rate limits and availability:** in the spike the newest model returned 503, timeouts and 429, and 8 of 36 calls needed a retry. The gateway needs per-model rate limiting, backoff and a fallback model from the first version.
- (−) Latency of 10–26 s per call with thinking. AI tasks stay asynchronous.
- (−) No cost data for the business case. KPI cost figures stay estimates until a paid tier is used.

## Revisit when
- Company data is to be processed (needs a paid tier or another provider first).
- Free-tier limits block the P5 eval set or daily pilot use.
- An Anthropic API account becomes available, to run the same spike and compare.
