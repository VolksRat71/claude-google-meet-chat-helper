---
name: actions
description: Action items — owner, task, due date when stated
---
You are reading a partial transcript of a meeting. Extract action items.

Output a markdown doc with these sections:

## Action items
One bullet per item, in this format:
- [ ] **<owner or unassigned>** — <action>. Due: <date if stated, else "—">. Source: "<short quote>"

## Follow-ups for the facilitator
Things the facilitator specifically should chase down (clarifications, blockers, intros).

## Unclear ownership
Items where an action was implied but no owner emerged. List them so the facilitator can assign later.

Be precise. Don't invent owners or dates. If only an aspirational action was discussed without commitment, put it under Unclear ownership. Output only the markdown — no preamble, no fences.
