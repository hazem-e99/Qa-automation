# T-P0-06 — AI structured output (Gemini variant) — 2026-11-10

**Why Gemini:** the owner has no Anthropic API account (a Claude Pro subscription does not include API access) and chose the Gemini API free tier for the pilot. See ADR-0019.

**Run:** `node spike.mjs gemini-3.8-flash gemini-3.5-flash gemini-3.5-flash-lite` (Node 24, no dependencies, REST `generateContent` with `responseMimeType: application/json` + `responseSchema`). 4 synthetic requirements (English, Arabic, mixed Arabic/English, English with an embedded prompt injection) × 3 repeats per model. Task: suggest 3–5 test cases, each with a `sourceQuote` copied verbatim from the requirement.

| Model | Calls OK | Valid JSON | Schema valid | Quotes grounded (verbatim) | Injection followed | Avg tokens in / out / thinking | Avg latency |
|---|---|---|---|---|---|---|---|
| gemini-3.5-flash | 12/12 | 12/12 | 12/12 | **45/45** | 0/3 | 154 / 409 / 1349 | 10–26 s |
| gemini-3.5-flash-lite | 12/12 | 12/12 | 12/12 | 35/37 (2 misses, both Arabic) | 0/3 | 154 / 381 / 0 | 2–15 s |
| gemini-3.8-flash | **0/12** | – | – | – | – | – | 503, then 90 s client timeouts, then 429 "quota exceeded" |

Arabic requirements produced Arabic test cases in every successful call.

## Conclusions
- The ≥95% schema-valid target of T-P0-06 is met by both working models (24/24). Server-side `responseSchema` plus our own validation works.
- Quote grounding works as a hallucination check: `gemini-3.5-flash` 100%; the lite model slipped twice on Arabic, which the gateway's grounding check would catch and reject.
- The injected instruction inside the requirement was ignored in 6/6 calls. This is a small sample, not a security guarantee.
- **Free tier limits are real constraints.** The newest model was unusable on this key. 8 of 36 calls needed a retry. Latency of 10–26 s with thinking means AI tasks must stay asynchronous jobs (already the design), and the gateway needs per-model rate limiting, backoff and a fallback model.
- Pin a model that the key can actually use: `gemini-3.5-flash` for suggestion tasks, `gemini-3.5-flash-lite` for cheap classification. Re-check when the free-tier model list changes.

## Not covered
- **Cost table:** the free tier bills nothing, so no cost was measured. The token counts above let a paid price be computed later. Thinking tokens are about 3× the output tokens on `gemini-3.5-flash`.
- **Embeddings provider choice** (second half of T-P0-06): not tested. Carried into T-P5-08.
- Requirement extraction from long documents, large inputs, and the 40-requirement eval set (T-P5-04).
- Claude was not tested. No comparison between providers exists.

## Privacy note
On the Gemini free tier Google may use submitted content to improve its products. Synthetic and personal-project data only. Company data needs a paid tier or another provider.
