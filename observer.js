import puppeteer from 'puppeteer';
import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'fs';

const TRANSCRIPT_FILE = `transcript-${Date.now()}.jsonl`;
const NUDGE_INTERVAL_MS = 2 * 60 * 1000;
const MODEL_ID = 'opus';
const DEBUG_OVERLAY = false;

const seen = new Set();
const transcript = [];
let lastNudgeIndex = 0;
let overlayAttachCount = 0;

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
  console.log('   Type "session over" + Enter to flush final notes and exit.');

  process.stdin.on('data', (data) => {
    const cmd = data.toString().trim().toLowerCase();
    if (cmd === 'session over') endSession();
  });

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
    await injectOverlay();
  }, 3000);

  setInterval(nudgeTurn, NUDGE_INTERVAL_MS);
  console.log(`🟣 Nudge loop active. Asking ${MODEL_ID} every ${NUDGE_INTERVAL_MS / 1000}s.${DEBUG_OVERLAY ? ' [DEBUG_OVERLAY=true]' : ''}`);
}

async function injectOverlay() {
  try {
    const result = await page.evaluate((debug) => {
      if (document.getElementById('claude-observer-overlay')) {
        return { attached: false };
      }
      const div = document.createElement('div');
      div.id = 'claude-observer-overlay';
      div.style.cssText = `
        position: fixed; top: 20px; right: 20px; z-index: 2147483647;
        width: 280px; padding: 12px 14px;
        background: rgba(20,20,20,0.85); backdrop-filter: blur(8px);
        color: white; font: 13px/1.4 system-ui, -apple-system, sans-serif;
        border-radius: 8px; border-left: 3px solid #6b7280;
        pointer-events: none; transition: opacity 0.3s;
        opacity: ${debug ? '1' : '0'};
      `;
      if (debug) div.textContent = 'observer active — waiting for first nudge';
      document.body.appendChild(div);
      return { attached: true };
    }, DEBUG_OVERLAY);

    if (result?.attached) {
      overlayAttachCount += 1;
      if (overlayAttachCount === 1 || overlayAttachCount % 5 === 0) {
        console.log(`🪟 overlay attached (count=${overlayAttachCount})`);
      }
    }
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

function endSession() {
  const finalFile = `final-${Date.now()}.json`;
  console.log(`🟡 Session ended. Writing ${transcript.length} entries to ${finalFile}.`);
  try {
    fs.writeFileSync(finalFile, JSON.stringify({
      transcript_file: TRANSCRIPT_FILE,
      ended_at: Date.now(),
      entry_count: transcript.length,
      transcript,
    }, null, 2));
  } catch (err) {
    console.error('final dump error:', err.message);
  }
  process.exit(0);
}

async function nudgeTurn() {
  const newEntries = transcript.slice(lastNudgeIndex);
  if (newEntries.length === 0) return;
  lastNudgeIndex = transcript.length;

  const transcriptText = newEntries
    .map(e => `${e.speaker}: ${e.text}`)
    .join('\n');

  try {
    const result = query({
      prompt: transcriptText,
      options: {
        systemPrompt: SYSTEM_PROMPT,
        model: MODEL_ID,
        maxTurns: 1,
        tools: [],
        effort: 'low',
      },
    });

    let raw = '';
    for await (const msg of result) {
      if (msg.type !== 'assistant') continue;
      for (const block of msg.message.content) {
        if (block.type === 'text') raw += block.text;
      }
    }

    const parsed = JSON.parse(stripFences(raw).trim());
    if (parsed.urgency !== 'none' && parsed.text) {
      console.log(`💡 [${parsed.urgency}] ${parsed.text}`);
      await injectOverlay();
      await showNudge(parsed);
    }
  } catch (err) {
    console.error('nudge error:', err.message);
  }
}

function stripFences(s) {
  return s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
}
