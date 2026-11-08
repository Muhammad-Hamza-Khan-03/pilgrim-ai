# pilgrim-ai

An AI travel assistant for Umrah websites. It answers questions from the site's own content, builds priced Makkah and Madinah hotel stays through natural conversation, and hands the chosen option to an agent on WhatsApp.

## What it does

- **Answers questions with sources.** Hybrid search (keyword + vector) with reranking over website pages, PDFs, text and Markdown, citing every answer.
- **Recommends hotel stays.** Collects travelers, dates and the Makkah/Madinah split, then shows 3 priced options as cards and refines them ("cheaper", "closer to the Haram").
- **Hands off to a person.** Saves the lead, then opens WhatsApp with the full request pre-filled.

## How it's built

- **Generic engine + domain pack.** Nothing about Umrah is hardcoded; slots, pricing rules, ranking, cards and prompts live in versioned config.
- **Exact prices.** Computed in code from rate tables, never by an LLM.
- **Resilient.** LLM fallback chain: Groq → Gemini → Workers AI → OpenAI, with a no-LLM degraded mode.
- **Guarded.** Layered guardrails mapped to the OWASP Top 10 for LLM Applications.
- **Serverless and $0 to run** at demo scale on Cloudflare's free plan.

## Tech stack

TypeScript · Hono · Cloudflare Workers, Durable Objects, D1, Vectorize, Workers AI, AI Gateway, KV, R2, Queues, Pages · Vercel AI SDK · Zod · Preact · WordPress plugin (PHP) · Python (Docling, Pydantic) for offline ingestion
