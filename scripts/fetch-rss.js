import 'dotenv/config';
import Parser from 'rss-parser';
import * as cheerio from 'cheerio';
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

async function fetchOGImage(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TechNewsHub/1.0)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);
    return (
      $('meta[property="og:image"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content') ||
      null
    );
  } catch {
    return null;
  }
}

async function fetchSource(source, db) {
  const parser = new Parser({
    customFields: { item: ['media:content', 'media:thumbnail', 'enclosure'] },
  });

  console.log(`Fetching ${source.name}...`);
  const feed = await parser.parseURL(source.url);
  const existingLinks = new Set(db.articles.map((a) => a.link));
  let added = 0;
  let nextId = db.articles.length > 0 ? Math.max(...db.articles.map((a) => a.id)) + 1 : 1;

  for (const item of feed.items) {
    const link = item.link?.trim();
    if (!link || existingLinks.has(link)) continue;

    let imageUrl =
      item['media:content']?.['$']?.url ||
      item['media:thumbnail']?.['$']?.url ||
      item.enclosure?.url ||
      null;

    if (!imageUrl) {
      imageUrl = await fetchOGImage(link);
    }

    const rawDesc = item.contentSnippet || item.content || item.summary || '';
    const description_en = rawDesc.replace(/<[^>]+>/g, '').trim().slice(0, 500);

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
      created_at: new Date().toISOString(),
    };

    db.articles.push(article);
    existingLinks.add(link);
    added++;
    console.log(`  + ${item.title?.slice(0, 70)}`);
  }

  console.log(`  ${source.name}: ${added} new articles`);
  return added;
}

async function main() {
  const { sources } = JSON.parse(readFileSync(join(ROOT, 'data', 'sources.json'), 'utf8'));
  const enabled = sources.filter((s) => s.enabled);
  const db = loadDb();

  let total = 0;
  for (const source of enabled) {
    try {
      total += await fetchSource(source, db);
    } catch (err) {
      console.error(`Error fetching ${source.name}:`, err.message);
    }
  }

  saveDb(db);
  console.log(`\nDone. Total new articles: ${total}. Total in DB: ${db.articles.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
