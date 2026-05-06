import 'dotenv/config';
import Parser from 'rss-parser';
import * as cheerio from 'cheerio';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DB_PATH = join(ROOT, 'data', 'articles.json');

const HOT_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours
const FEED_TIMEOUT_MS = 5000; // 5 seconds per feed (was 10s, too slow)

// AI relevance filter: article must contain at least one of these keywords
const AI_KEYWORDS = [
  // Core AI/ML
  'ai', 'a.i.', 'artificial intelligence', 'machine learning', 'deep learning',
  'neural network', 'llm', 'large language model', 'generative ai', 'gen ai',
  'foundation model', 'transformer', 'embedding', 'rag', 'fine-tun',
  'agent', 'agentic', 'autonomous',
  // Companies & products
  'openai', 'chatgpt', 'gpt-4', 'gpt-5', 'gpt-6', 'sora', 'dall-e', 'dalle',
  'anthropic', 'claude', 'mistral', 'cohere',
  'google ai', 'gemini', 'bard', 'deepmind', 'imagen', 'veo',
  'meta ai', 'llama', 'facebook ai',
  'microsoft ai', 'copilot', 'azure ai', 'phi-',
  'nvidia', 'cuda', 'h100', 'h200', 'b100', 'b200', 'blackwell', 'gpu',
  'apple intelligence', 'apple ai', 'siri',
  'amazon bedrock', 'aws ai', 'alexa',
  'huggingface', 'hugging face',
  'stability', 'stable diffusion', 'midjourney', 'flux', 'runway', 'pika',
  'perplexity', 'elevenlabs', 'eleven labs',
  'xai', 'grok',
  'nano banana', 'nano-banana',
  // Topics
  'chatbot', 'voice ai', 'computer vision', 'speech recognition',
  'image generation', 'video generation', 'music generation',
  'prompt engineering', 'inference', 'training data', 'reinforcement learning',
  'agi', 'asi', 'singularity',
  'robotics', 'humanoid', 'autonomous vehicle', 'self-driving',
  'open source ai', 'open-source ai',
  // Hebrew (in case Hebrew sources arrive)
  'בינה מלאכותית', 'למידת מכונה', 'למידה עמוקה', 'מודל שפה',
  'רשת נוירונים', 'בוט שיחה', 'יצירת תמונות',
];

function isAIRelated(title, description, source) {
  // Whitelist: dedicated AI sources skip the filter (they're AI-only)
  const aiOnlySources = [
    'TechCrunch AI', 'The Verge AI', 'VentureBeat AI', 'OpenAI Blog',
    'Anthropic', 'Hugging Face Blog', 'Google AI', 'MarkTechPost',
    'The Decoder', 'AI News', 'Hi, AI English (TG)', 'Hi, AI Russian (TG)',
    'AI Post (TG)', 'Prompt AI News (TG)', 'Artificial Intelligence (TG)',
    'Data Science ODS.ai (TG)', 'XOR Journal (TG)',
  ];
  if (aiOnlySources.some(s => (source || '').includes(s.replace(' (TG)', '')))) return true;

  const text = `${title || ''} ${description || ''}`.toLowerCase();
  return AI_KEYWORDS.some(kw => text.includes(kw));
}

function loadDb() {
  if (!existsSync(DB_PATH)) return { articles: [] };
  try {
    const raw = JSON.parse(readFileSync(DB_PATH, 'utf8'));
    // Support both formats: { articles: [...] } or plain [...]
    if (Array.isArray(raw)) return { articles: raw };
    return raw;
  } catch { return { articles: [] }; }
}

function saveDb(db) {
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

async function fetchTelegramSource(source, db, cutoffDate, now) {
  console.log(`Fetching ${source.name} (Telegram)...`);
  const res = await fetch(source.url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS * 2), // Telegram can be slower
  });
  if (!res.ok) throw new Error(`Telegram HTTP ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const existingLinks = new Set(db.articles.map((a) => a.link));
  let added = 0;
  let nextId = db.articles.length > 0 ? Math.max(...db.articles.map((a) => a.id)) + 1 : 1;
  const items = [];

  $('.tgme_widget_message_wrap').each((_, el) => {
    const $el = $(el);
    const text = $el.find('.tgme_widget_message_text').first().text().trim();
    if (!text) return;
    const dateLink = $el.find('.tgme_widget_message_date').attr('href') || '';
    const dateAttr = $el.find('.tgme_widget_message_date time').attr('datetime') || '';
    const photoStyle = $el.find('.tgme_widget_message_photo_wrap').attr('style') || '';
    const photoMatch = photoStyle.match(/url\(['"]?(https?:[^'")\s]+)['"]?\)/);
    items.push({ text, link: dateLink, pubDate: dateAttr, image: photoMatch?.[1] || null });
  });

  for (const item of items) {
    const link = item.link?.trim();
    if (!link || existingLinks.has(link)) continue;

    const pubDate = new Date(item.pubDate || 0);
    if (pubDate < cutoffDate) continue;

    const lines = item.text.split('\n').map(l => l.trim()).filter(Boolean);
    const title = lines[0]?.slice(0, 200) || '(untitled)';
    const description = item.text.replace(/<[^>]+>/g, '').trim().slice(0, 500);

    if (!isAIRelated(title, description, source.name)) continue;

    const ageMs = now - pubDate.getTime();
    const priority = ageMs < HOT_WINDOW_MS ? 'hot' : 'batch';

    const article = {
      id: nextId++,
      source: source.name,
      title_en: title,
      description_en: description,
      title_he: null,
      description_he: null,
      link,
      image_url: item.image || null,
      pub_date: item.pubDate || new Date().toISOString(),
      author: null,
      categories: [],
      translated: false,
      priority,
      fetchedAt: new Date().toISOString(),
      created_at: new Date().toISOString(),
    };

    db.articles.push(article);
    existingLinks.add(link);
    added++;
    console.log(`  + [${priority}] ${title.slice(0, 70)}`);
  }

  console.log(`  ${source.name}: ${added} new articles`);
  return added;
}

async function fetchSource(source, db, cutoffDate, now) {
  // Dispatch to Telegram scraper for t.me URLs
  if (source.url.includes('t.me/s/')) {
    return fetchTelegramSource(source, db, cutoffDate, now);
  }

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

    const titleStr = item.title?.trim() || '';
    if (!isAIRelated(titleStr, description_en, source.name)) continue;

    const ageMs = now - pubDate.getTime();
    const priority = ageMs < HOT_WINDOW_MS ? 'hot' : 'batch';

    const article = {
      id: nextId++,
      source: source.name,
      title_en: titleStr,
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
  const HARD_PER_SOURCE_MS = 15000; // hard kill any source after 15s (unstuck guarantee)
  const startTime = Date.now();
  let total = 0;

  // Wraps fetchSource with a HARD timeout - prevents one stuck feed from hanging the whole run
  function fetchWithHardTimeout(source) {
    return Promise.race([
      fetchSource(source, db, cutoffDate, now),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error(`hard timeout ${HARD_PER_SOURCE_MS}ms`)), HARD_PER_SOURCE_MS)
      ),
    ]);
  }

  for (let i = 0; i < enabled.length; i += BATCH_SIZE) {
    if (Date.now() - startTime > GLOBAL_TIMEOUT_MS) {
      console.log('⏱ Global timeout reached, saving progress...');
      break;
    }
    const batch = enabled.slice(i, i + BATCH_SIZE);
    console.log(`\nBatch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.map(s => s.name).join(', ')}`);
    const results = await Promise.allSettled(batch.map(fetchWithHardTimeout));
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
