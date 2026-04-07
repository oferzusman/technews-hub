import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DB_PATH = join(ROOT, 'data', 'articles.json');

// Fail fast if no API key
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY environment variable is not set.');
  process.exit(1);
}

const mode = process.argv.includes('--mode=batch') ? 'batch' : 'realtime';
const MAX_PER_RUN = mode === 'batch' ? 30 : 999;
const DELAY_MS = mode === 'batch' ? 1000 : 200;

console.log(`Mode: ${mode} (max: ${MAX_PER_RUN}, delay: ${DELAY_MS}ms)`);

function loadDb() {
  if (!existsSync(DB_PATH)) return { articles: [] };
  try { return JSON.parse(readFileSync(DB_PATH, 'utf8')); } catch { return { articles: [] }; }
}

function saveDb(db) {
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

const client = new Anthropic();

const SYSTEM_PROMPT = `You are a Hebrew tech news writer for a popular Israeli AI news channel.
Translate this article title and write a 2-3 sentence Hebrew summary in a casual, engaging tone similar to Israeli tech blogs.
The summary should be informative but not a direct translation - write it as if you're telling Israeli readers about this news.
Keep technical terms in English where natural (like AI, API, GPU etc).
Include the source credit at the end.

IMPORTANT: Respond with ONLY a raw JSON object. No markdown, no code fences, no explanation. Just the JSON.`;

async function translateArticle(article) {
  const userMessage = `Article title: "${article.title_en}"
Article description: "${article.description_en}"
Source: ${article.source}

Respond with ONLY this JSON (no markdown, no code blocks):
{"title_he": "...", "description_he": "..."}`;

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  let text = message.content[0].text.trim();

  // Strip markdown code fences if Claude wrapped the response
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  // Find the JSON object in case there's extra text
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`No JSON found in response: ${text.slice(0, 200)}`);
  }

  return JSON.parse(jsonMatch[0]);
}

async function main() {
  const db = loadDb();

  const candidates = mode === 'realtime'
    ? db.articles.filter((a) => !a.translated && a.priority === 'hot')
    : db.articles.filter((a) => !a.translated && a.priority !== 'hot');

  const toTranslate = candidates.slice(0, MAX_PER_RUN);

  console.log(`Total articles: ${db.articles.length}`);
  console.log(`Candidates (${mode}): ${candidates.length}`);
  if (candidates.length > MAX_PER_RUN) {
    console.log(`Capping to ${MAX_PER_RUN} (${candidates.length - MAX_PER_RUN} deferred)`);
  }

  if (toTranslate.length === 0) {
    console.log('Nothing to translate.');
    return;
  }

  let successCount = 0;
  let errorCount = 0;

  for (const article of toTranslate) {
    try {
      console.log(`[${successCount + errorCount + 1}/${toTranslate.length}] Translating: ${article.title_en?.slice(0, 60)}...`);
      const { title_he, description_he } = await translateArticle(article);

      const idx = db.articles.findIndex((a) => a.id === article.id);
      if (idx !== -1) {
        db.articles[idx].title_he = title_he;
        db.articles[idx].description_he = description_he;
        db.articles[idx].translated = true;
      }

      console.log(`  ✓ ${title_he?.slice(0, 60)}`);
      successCount++;

      // Save after every 5 articles so progress isn't lost on failure
      if (successCount % 5 === 0) saveDb(db);

      await new Promise((r) => setTimeout(r, DELAY_MS));
    } catch (err) {
      errorCount++;
      console.error(`  ✗ Error on article ${article.id}: ${err.message}`);
    }
  }

  saveDb(db);
  console.log(`\nDone. Translated: ${successCount}, Errors: ${errorCount}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
});
