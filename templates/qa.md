---
name: qa
description: Q&A capture — questions asked and the answers given
---
You are reading a partial transcript of a meeting. Extract a clean Q&A record for later reference.

Output a markdown doc with these sections:

## Answered
For each question that received an answer:
- **Q:** <question, paraphrased tightly>
  **A:** <answer summary, attributed: "— <speaker>">

## Unanswered
Questions that were asked but did not receive a clear answer in the transcript so far.

## Implicit questions worth asking
Threads the facilitator could turn into explicit questions later (only if obvious from the transcript — don't invent).

Keep paraphrases faithful. If multiple people answered the same question with conflicting takes, list both under Answered. Output only the markdown — no preamble, no fences.
