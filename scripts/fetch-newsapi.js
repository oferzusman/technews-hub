import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DB_PATH = join(ROOT, 'data', 'articles.json');

const HOT_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

if (!process.env.NEWSAPI_KEY) {
  console.warn('WARNING: NEWSAPI_KEY is not set — skipping NewsAPI fetch.');
  process.exit(0);
}

const API_KEY = process.env.NEWSAPI_KEY;
const BASE_URL = 'https://newsapi.org/v2/everything';

function loadDb() {
  if (!existsSync(DB_PATH)) return { articles: [] };
  try {
    const raw = JSON.parse(readFileSync(DB_PATH, 'utf8'));
    if (Array.isArray(raw)) return { articles: raw };
    return raw;
  } catch { return { articles: [] }; }
}

function saveDb(db) {
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

async function fetchQuery(query, existingLinks) {
  const params = new URLSearchParams({
    q: query,
    language: 'en',
    sortBy: 'publishedAt',
    pageSize: '100',
    apiKey: API_KEY,
  });

  const url = `${BASE_URL}?${params}`;
  console.log(`Fetching NewsAPI: ${query.slice(0, 60)}...`);

  const res = await fetch(url, {
    headers: { 'User-Agent': 'TechNewsHub/1.0' },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`NewsAPI HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();

  if (data.status !== 'ok') {
    throw new Error(`NewsAPI error: ${data.message || data.code || 'unknown'}`);
  }

  return (data.articles || []).filter((a) => {
    const link = a.url?.trim();
    return link && link !== 'https://removed.com' && !existingLinks.has(link);
  });
}

async function main() {
  const db = loadDb();
  const existingLinks = new Set(db.articles.map((a) => a.link));
  let nextId = db.articles.length > 0 ? Math.max(...db.articles.map((a) => a.id)) + 1 : 1;
  const now = Date.now();

  const queries = [
    'artificial intelligence OR machine learning OR LLM OR "large language model"',
    'OpenAI OR Anthropic OR "Google AI" OR ChatGPT OR Claude OR Gemini',
  ];

  let totalAdded = 0;

  for (const query of queries) {
    let rawArticles;
    try {
      rawArticles = await fetchQuery(query, existingLinks);
    } catch (err) {
      console.error(`  Error fetching query "${query.slice(0, 40)}": ${err.message}`);
      continue;
    }

    console.log(`  ${rawArticles.length} new articles from query`);

    for (const item of rawArticles) {
      const link = item.url.trim();

      const pubDate = item.publishedAt ? new Date(item.publishedAt) : new Date();
      const ageMs = now - pubDate.getTime();
      const priority = ageMs < HOT_WINDOW_MS ? 'hot' : 'batch';

      const sourceName = item.source?.name || 'NewsAPI';
      const description_en = (item.description || item.content || '')
        .replace(/<[^>]+>/g, '')
        .replace(/\[\+\d+ chars\]$/, '')
        .trim()
        .slice(0, 500);

      const article = {
        id: nextId++,
        source: sourceName,
        title_en: item.title?.trim() || '',
        description_en,
        title_he: null,
        description_he: null,
        link,
        image_url: item.urlToImage || null,
        pub_date: item.publishedAt || new Date().toISOString(),
        author: item.author || null,
        categories: [],
        translated: false,
        priority,
        fetchedAt: new Date().toISOString(),
        created_at: new Date().toISOString(),
      };

      db.articles.push(article);
      existingLinks.add(link);
      totalAdded++;
      console.log(`  + [${priority}] ${item.title?.slice(0, 70)}`);
    }
  }

  saveDb(db);

  const hot = db.articles.filter((a) => !a.translated && a.priority === 'hot').length;
  const batch = db.articles.filter((a) => !a.translated && a.priority === 'batch').length;
  console.log(`\nDone. Added: ${totalAdded}. Total in DB: ${db.articles.length}`);
  console.log(`Untranslated — hot: ${hot}, batch: ${batch}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
