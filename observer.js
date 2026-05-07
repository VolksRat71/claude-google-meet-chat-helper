import puppeteer from 'puppeteer';
import fs from 'fs';

const TRANSCRIPT_FILE = `transcript-${Date.now()}.jsonl`;
const seen = new Set();
const transcript = [];

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
}
