import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DB_PATH = join(ROOT, 'data', 'articles.json');

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
Include the source credit at the end.`;

async function translateArticle(article) {
  const userMessage = `Article title: "${article.title_en}"
Article description: "${article.description_en}"
Source: ${article.source}

Please respond with ONLY a JSON object in this exact format (no markdown, no extra text):
{
  "title_he": "Hebrew title here",
  "description_he": "Hebrew summary here (2-3 sentences, casual tone, source credit at end)"
}`;

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = message.content[0].text.trim();
  return JSON.parse(text);
}

async function main() {
  const db = loadDb();
  const untranslated = db.articles.filter((a) => !a.translated);

  console.log(`Found ${untranslated.length} untranslated articles`);

  for (const article of untranslated) {
    try {
      console.log(`Translating: ${article.title_en?.slice(0, 60)}...`);
      const { title_he, description_he } = await translateArticle(article);

      const idx = db.articles.findIndex((a) => a.id === article.id);
      if (idx !== -1) {
        db.articles[idx].title_he = title_he;
        db.articles[idx].description_he = description_he;
        db.articles[idx].translated = true;
      }

      console.log(`  -> ${title_he?.slice(0, 60)}`);
      await new Promise((r) => setTimeout(r, 300));
    } catch (err) {
      console.error(`  Error translating article ${article.id}:`, err.message);
    }
  }

  saveDb(db);
  console.log('\nTranslation complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
