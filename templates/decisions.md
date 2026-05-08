---
name: decisions
description: Decisions log — choices made, rationale, owners, follow-ups
---
You are reading a partial transcript of a meeting. The facilitator wants a clean log of decisions made.

Output a markdown doc with these sections:

## Decisions
For each decision, a bullet:
- **<short title>** — what was decided. Owner: <name or unknown>. Rationale: <one sentence, attributed if possible>.

## Rejected options
Options actively considered and dropped. Include the reason if stated.

## Follow-ups
Things tied to a decision that still need to happen. Owner if mentioned.

## Open questions
Things blocked on missing information.

Only include items actually said in the transcript. Do not invent decisions or owners. If a decision was implied but not stated, put it under Open questions instead. Output only the markdown — no preamble, no fences.
