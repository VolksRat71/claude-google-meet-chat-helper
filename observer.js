import puppeteer from 'puppeteer';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';

const TRANSCRIPT_FILE = `transcript-${Date.now()}.jsonl`;
const NUDGE_INTERVAL_MS = 2 * 60 * 1000;
const MODEL_ID = 'claude-opus-4-7';

const seen = new Set();
const transcript = [];
let lastNudgeIndex = 0;

const claude = new Anthropic();

const SYSTEM_PROMPT = `You are an observer for a creative-team workflow tutoring session.

A team member is walking through a real, annoying 30–50 minute task on screen share. The facilitator is running this session to identify an opportunity to build a Gemini gem that helps with this task.

Your job: every 2 minutes you receive the latest chunk of the meeting transcript. Decide whether there is ONE short suggestion the facilitator should consider asking right now to deepen the discovery — something that pulls on a thread the team mentioned but didn't explain, or a friction point worth pushing on.

Output JSON only, no markdown fences:
{ "urgency": "now" | "later" | "none", "text": "..." }

- "now" = ask this in the next minute or two, it's about something just said
- "later" = worth coming back to, the facilitator can save it for the end
- "none" = nothing worth surfacing this turn

Keep "text" to 1–2 short sentences. The facilitator is talking and listening simultaneously and will glance at the overlay for half a second.

Pay attention to: workflow entry points, handoffs, friction (operational/cognitive/technical), informal knowledge, repetitive manual steps, things they hand-wave past. Do NOT pattern-match toward AI solutions. Just observe and surface threads.`;

const browser = await puppeteer.launch({
  headless: false,
  defaultViewport: null,
  args: ['--start-maximized'],
});
const page = (await browser.pages())[0];
await page.goto('https://meet.google.com/');

console.log('🟢 Log into Google and join the Meet. Press Enter here when captions are ON.');
process.stdin.once('data', () => startScraping());

async function startScraping() {
  console.log(`🔵 Scraping captions every 3s. Writing to ${TRANSCRIPT_FILE}.`);

  setInterval(async () => {
    try {
      const lines = await page.evaluate(() => {
        // Meet caption DOM drifts. These selectors WILL be wrong eventually —
        // open DevTools in this Chromium, inspect a caption row, and replace.
        const nodes = document.querySelectorAll('[jsname="tgaKEf"], .iOzk7, .TBMuR');
        return Array.from(nodes).map(n => {
          const speaker = n.querySelector('.zs7s8d, .NWpY1d')?.textContent?.trim() || 'unknown';
          const text = n.querySelector('.bh44bd, .ygicle')?.textContent?.trim() || n.textContent?.trim() || '';
          return { speaker, text };
        }).filter(x => x.text);
      });

      for (const line of lines) {
        const key = `${line.speaker}::${line.text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const entry = { t: Date.now(), ...line };
        transcript.push(entry);
        fs.appendFileSync(TRANSCRIPT_FILE, JSON.stringify(entry) + '\n');
        console.log(`[${line.speaker}] ${line.text}`);
      }
    } catch (err) {
      console.error('scrape error:', err.message);
    }
  }, 3000);

  await injectOverlay();
  setInterval(nudgeTurn, NUDGE_INTERVAL_MS);
  console.log(`🟣 Nudge loop active. Asking ${MODEL_ID} every ${NUDGE_INTERVAL_MS / 1000}s.`);
}

async function injectOverlay() {
  try {
    await page.evaluate(() => {
      if (document.getElementById('claude-observer-overlay')) return;
      const div = document.createElement('div');
      div.id = 'claude-observer-overlay';
      div.style.cssText = `
        position: fixed; top: 20px; right: 20px; z-index: 999999;
        width: 280px; padding: 12px 14px;
        background: rgba(20,20,20,0.85); backdrop-filter: blur(8px);
        color: white; font: 13px/1.4 system-ui, -apple-system, sans-serif;
        border-radius: 8px; border-left: 3px solid #6b7280;
        pointer-events: none; opacity: 0; transition: opacity 0.3s;
      `;
      document.body.appendChild(div);
    });
  } catch (err) {
    console.error('overlay inject error:', err.message);
  }
}

async function showNudge({ urgency, text }) {
  const color = urgency === 'now' ? '#f97316' : '#6b7280';
  try {
    await page.evaluate((text, color) => {
      let div = document.getElementById('claude-observer-overlay');
      if (!div) return;
      div.textContent = text;
      div.style.borderLeftColor = color;
      div.style.opacity = '1';
    }, text, color);
  } catch (err) {
    console.error('overlay update error:', err.message);
  }
}

async function nudgeTurn() {
  const newEntries = transcript.slice(lastNudgeIndex);
  if (newEntries.length === 0) return;
  lastNudgeIndex = transcript.length;

  const transcriptText = newEntries
    .map(e => `${e.speaker}: ${e.text}`)
    .join('\n');

  try {
    const resp = await claude.messages.create({
      model: MODEL_ID,
      max_tokens: 200,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: transcriptText }],
    });
    const raw = resp.content[0].text.trim();
    const parsed = JSON.parse(raw);
    if (parsed.urgency !== 'none' && parsed.text) {
      console.log(`💡 [${parsed.urgency}] ${parsed.text}`);
      await injectOverlay();
      await showNudge(parsed);
    }
  } catch (err) {
    console.error('nudge error:', err.message);
  }
}
