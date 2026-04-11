import 'dotenv/config';
import Parser from 'rss-parser';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DB_PATH = join(ROOT, 'data', 'articles.json');

const HOT_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours
const FEED_TIMEOUT_MS = 10000; // 10 seconds per feed

function loadDb() {
  if (!existsSync(DB_PATH)) return { articles: [] };
  try { return JSON.parse(readFileSync(DB_PATH, 'utf8')); } catch { return { articles: [] }; }
}

function saveDb(db) {
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

async function fetchSource(source, db, cutoffDate, now) {
  const parser = new Parser({
    customFields: { item: ['media:content', 'media:thumbnail', 'enclosure'] },
    timeout: FEED_TIMEOUT_MS,
  });

  console.log(`Fetching ${source.name}...`);
  const feed = await parser.parseURL(source.url);
  const existingLinks = new Set(db.articles.map((a) => a.link));
  let added = 0;
  let nextId = db.articles.length > 0 ? Math.max(...db.articles.map((a) => a.id)) + 1 : 1;

  for (const item of feed.items) {
    const link = item.link?.trim();
    if (!link || existingLinks.has(link)) continue;

    const pubDate = new Date(item.pubDate || item.isoDate || 0);
    if (pubDate < cutoffDate) continue;

    const imageUrl =
      item['media:content']?.['$']?.url ||
      item['media:thumbnail']?.['$']?.url ||
      item.enclosure?.url ||
      null;

    const rawDesc = item.contentSnippet || item.content || item.summary || '';
    const description_en = rawDesc.replace(/<[^>]+>/g, '').trim().slice(0, 500);

    const ageMs = now - pubDate.getTime();
    const priority = ageMs < HOT_WINDOW_MS ? 'hot' : 'batch';

    const article = {
      id: nextId++,
      source: source.name,
      title_en: item.title?.trim() || '',
      description_en,
      title_he: null,
      description_he: null,
      link,
      image_url: imageUrl || null,
      pub_date: item.pubDate || item.isoDate || new Date().toISOString(),
      author: item.creator || item.author || null,
      categories: item.categories || [],
      translated: false,
      priority,
      fetchedAt: new Date().toISOString(),
      created_at: new Date().toISOString(),
    };

    db.articles.push(article);
    existingLinks.add(link);
    added++;
    console.log(`  + [${priority}] ${item.title?.slice(0, 70)}`);
  }

  console.log(`  ${source.name}: ${added} new articles`);
  return added;
}

async function main() {
  const { sources } = JSON.parse(readFileSync(join(ROOT, 'data', 'sources.json'), 'utf8'));
  const enabled = sources.filter((s) => s.enabled);
  const db = loadDb();

  const now = Date.now();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 180);

  // Re-evaluate priority on existing untranslated articles
  for (const article of db.articles) {
    if (!article.translated) {
      const pubDate = new Date(article.pub_date);
      const ageMs = now - pubDate.getTime();
      article.priority = ageMs < HOT_WINDOW_MS ? 'hot' : 'batch';
    }
  }

  const BATCH_SIZE = 5;
  const GLOBAL_TIMEOUT_MS = 3.5 * 60 * 1000; // 3.5 min max
  const startTime = Date.now();
  let total = 0;

  for (let i = 0; i < enabled.length; i += BATCH_SIZE) {
    if (Date.now() - startTime > GLOBAL_TIMEOUT_MS) {
      console.log('⏱ Global timeout reached, saving progress...');
      break;
    }
    const batch = enabled.slice(i, i + BATCH_SIZE);
    console.log(`\nBatch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.map(s => s.name).join(', ')}`);
    const results = await Promise.allSettled(
      batch.map(source => fetchSource(source, db, cutoffDate, now))
    );
    for (let j = 0; j < results.length; j++) {
      if (results[j].status === 'fulfilled') {
        total += results[j].value;
      } else {
        console.error(`  ✗ ${batch[j].name}: ${results[j].reason?.message}`);
      }
    }
  }

  saveDb(db);

  const hot = db.articles.filter((a) => !a.translated && a.priority === 'hot').length;
  const batch = db.articles.filter((a) => !a.translated && a.priority === 'batch').length;
  console.log(`\nDone. New articles: ${total}. Total in DB: ${db.articles.length}`);
  console.log(`Untranslated — hot: ${hot}, batch: ${batch}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
