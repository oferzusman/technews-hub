import 'dotenv/config';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DB_PATH = join(ROOT, 'data', 'articles.json');

const CATEGORY_RULES = [
  { keywords: ['openai', 'chatgpt', 'gpt-4', 'gpt-5', 'sora'], co: 'OpenAI', tags: ['model'] },
  { keywords: ['google', 'gemini', 'deepmind', 'bard'], co: 'Google', tags: ['model'] },
  { keywords: ['anthropic', 'claude'], co: 'Anthropic', tags: ['model'] },
  { keywords: ['meta', 'llama', 'facebook ai'], co: 'Meta', tags: ['model'] },
  { keywords: ['microsoft', 'copilot', 'azure ai'], co: 'Microsoft', tags: ['product'] },
  { keywords: ['nvidia', 'gpu', 'cuda', 'h100', 'blackwell'], co: 'Nvidia', tags: ['hardware'] },
  { keywords: ['apple', 'siri', 'core ml'], co: 'Apple', tags: ['product'] },
  { keywords: ['amazon', 'aws', 'alexa', 'bedrock'], co: 'Amazon', tags: ['product'] },
  { keywords: ['stability', 'stable diffusion', 'midjourney', 'dall-e', 'image generation'], co: null, tags: ['image-gen'] },
  { keywords: ['robotics', 'robot', 'autonomous', 'boston dynamics'], co: null, tags: ['robotics'] },
  { keywords: ['regulation', 'law', 'policy', 'congress', 'eu ai act', 'ban'], co: null, tags: ['regulation'] },
  { keywords: ['funding', 'raises', 'investment', 'series', 'valuation', 'billion'], co: null, tags: ['funding'] },
  { keywords: ['security', 'hack', 'breach', 'vulnerability', 'jailbreak'], co: null, tags: ['security'] },
  { keywords: ['agent', 'agentic', 'autonomous agent', 'multi-agent'], co: null, tags: ['agents'] },
];

function categorize(title, description) {
  const text = `${title} ${description}`.toLowerCase();
  const companies = [];
  const tags = new Set(['news']);

  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((k) => text.includes(k))) {
      if (rule.co) companies.push(rule.co);
      rule.tags.forEach((t) => tags.add(t));
    }
  }

  let imp = 'low';
  const highSignals = ['launches', 'releases', 'announces', 'raises', 'acquires', 'breakthrough', 'billion'];
  const medSignals = ['updates', 'expands', 'partners', 'report', 'study'];
  if (highSignals.some((s) => text.includes(s))) imp = 'high';
  else if (medSignals.some((s) => text.includes(s))) imp = 'medium';

  return { cats: ['news'], co: [...new Set(companies)], tags: [...tags], imp };
}

function articleToEntry(article, id) {
  const { cats, co, tags, imp } = categorize(
    article.title_he || article.title_en || '',
    article.description_he || article.description_en || ''
  );

  const text = [
    article.title_he || article.title_en,
    article.description_he || article.description_en,
  ].filter(Boolean).join('\n\n');

  return {
    id,
    t: text,
    d: article.pub_date || new Date().toISOString(),
    v: 0,
    l: [article.link],
    lp: null,
    vid: false,
    img: !!article.image_url,
    fwd: null,
    cats,
    co,
    tags,
    imp,
    thumb: article.image_url || null,
    source: article.source,
  };
}

function loadTelegramData() {
  const telegramPath = join(ROOT, 'public', 'telegram_data.js');
  if (!existsSync(telegramPath)) return [];
  try {
    const raw = readFileSync(telegramPath, 'utf8');
    const match = raw.match(/window\.TELEGRAM_DATA\s*=\s*(\[[\s\S]*?\]);/);
    if (!match) return [];
    return JSON.parse(match[1]);
  } catch (err) {
    console.warn('Could not load telegram_data.js:', err.message);
    return [];
  }
}

async function main() {
  const rawDb = existsSync(DB_PATH)
    ? JSON.parse(readFileSync(DB_PATH, 'utf8'))
    : { articles: [] };
  const db = Array.isArray(rawDb) ? { articles: rawDb } : rawDb;

  // Include all articles; use translated text when available, fall back to English
  const translated = db.articles
    .slice()
    .sort((a, b) => new Date(b.pub_date) - new Date(a.pub_date));

  console.log(`Building data.js from ${translated.length} translated articles...`);

  const rssEntries = translated.map((a, i) => articleToEntry(a, i + 1));
  const telegramEntries = loadTelegramData().map((e) => ({ ...e, source: e.source || 'Telegram' }));

  const seenLinks = new Set();
  const combined = [];

  for (const entry of [...rssEntries, ...telegramEntries]) {
    const key = (entry.l || [])[0] || String(entry.id);
    if (!seenLinks.has(key)) {
      seenLinks.add(key);
      combined.push(entry);
    }
  }

  combined.forEach((e, i) => (e.id = i + 1));

  const output = `window.TELEGRAM_DATA = ${JSON.stringify(combined, null, 2)};\n`;
  const outPath = join(ROOT, 'public', 'data.js');
  writeFileSync(outPath, output, 'utf8');

  console.log(`Written ${combined.length} entries to public/data.js`);
  console.log(`  RSS articles: ${rssEntries.length}`);
  console.log(`  Telegram entries: ${telegramEntries.length}`);

  // Write admin-data.json for the admin dashboard
  const now = Date.now();
  const todayStart = new Date(new Date().toDateString()).getTime();
  const weekStart = todayStart - 6 * 24 * 60 * 60 * 1000;
  const allArticles = db.articles;

  const sourceMap = {};
  for (const a of allArticles) {
    const s = a.source || 'Unknown';
    if (!sourceMap[s]) sourceMap[s] = { name: s, total: 0, translated: 0, lastDate: null };
    sourceMap[s].total++;
    if (a.translated) sourceMap[s].translated++;
    const d = a.pub_date || a.fetchedAt;
    if (d && (!sourceMap[s].lastDate || d > sourceMap[s].lastDate)) sourceMap[s].lastDate = d;
  }

  const adminData = {
    total: allArticles.length,
    translated: allArticles.filter((a) => a.translated).length,
    untranslated: allArticles.filter((a) => !a.translated).length,
    today: allArticles.filter((a) => new Date(a.fetchedAt || a.pub_date).getTime() >= todayStart).length,
    week: allArticles.filter((a) => new Date(a.fetchedAt || a.pub_date).getTime() >= weekStart).length,
    sources: Object.values(sourceMap).sort((a, b) => b.total - a.total),
    generatedAt: new Date().toISOString(),
  };

  writeFileSync(join(ROOT, 'public', 'admin-data.json'), JSON.stringify(adminData, null, 2), 'utf8');
  console.log(`Written admin-data.json (${adminData.total} articles, ${adminData.translated} translated)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
