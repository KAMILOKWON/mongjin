import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const storeRoot = new URL('../store/', import.meta.url);
const appStoreRoot = new URL('./app-store/', storeRoot);
const googlePlayRoot = new URL('./google-play/', storeRoot);

const appStoreLocales = ['ko', 'en-US', 'ja', 'zh-Hans', 'zh-Hant'];
const googlePlayLocales = ['ko-KR', 'en-US', 'ja-JP', 'zh-CN', 'zh-TW'];
const searchableNames = ['mongjin', '蒙塵', '蒙尘', 'モンジン'];
const errors = [];

async function text(rootUrl, locale, filename) {
  const value = await readFile(new URL(`./${locale}/${filename}`, rootUrl), 'utf8');
  const content = value.endsWith('\n') ? value.slice(0, -1) : value;
  if (content !== content.trim()) {
    errors.push(`${locale}/${filename}: leading or trailing whitespace is not allowed`);
  }
  return content.trim();
}

function checkLimit(label, value, limit, unit = 'characters') {
  const length = unit === 'bytes' ? Buffer.byteLength(value, 'utf8') : [...value].length;
  if (length > limit) {
    errors.push(`${label}: ${length} ${unit}, limit ${limit}`);
  }
  return length;
}

function checkSearchNames(label, value) {
  const normalized = value.toLowerCase();
  for (const name of searchableNames) {
    if (!normalized.includes(name.toLowerCase())) {
      errors.push(`${label}: missing searchable name ${name}`);
    }
  }
}

async function checkLocales(rootUrl, expected) {
  const actual = (await readdir(rootUrl, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const wanted = [...expected].sort();
  if (actual.join('\n') !== wanted.join('\n')) {
    errors.push(`locales at ${fileURLToPath(rootUrl)}: expected ${wanted.join(', ')}, found ${actual.join(', ')}`);
  }
}

await checkLocales(appStoreRoot, appStoreLocales);
await checkLocales(googlePlayRoot, googlePlayLocales);

for (const locale of appStoreLocales) {
  const name = await text(appStoreRoot, locale, 'name.txt');
  const subtitle = await text(appStoreRoot, locale, 'subtitle.txt');
  const keywords = await text(appStoreRoot, locale, 'keywords.txt');
  const description = await text(appStoreRoot, locale, 'description.txt');
  const releaseNotes = await text(appStoreRoot, locale, 'release_notes.txt');
  await text(appStoreRoot, locale, 'support_url.txt');
  await text(appStoreRoot, locale, 'privacy_url.txt');

  checkLimit(`App Store ${locale} name`, name, 30);
  checkLimit(`App Store ${locale} subtitle`, subtitle, 30);
  checkLimit(`App Store ${locale} keywords`, keywords, 100, 'bytes');
  checkLimit(`App Store ${locale} description`, description, 4000);
  checkLimit(`App Store ${locale} release notes`, releaseNotes, 4000);
  checkSearchNames(`App Store ${locale}`, `${name}\n${subtitle}\n${keywords}`);
}

for (const locale of googlePlayLocales) {
  const title = await text(googlePlayRoot, locale, 'title.txt');
  const shortDescription = await text(googlePlayRoot, locale, 'short_description.txt');
  const fullDescription = await text(googlePlayRoot, locale, 'full_description.txt');

  checkLimit(`Google Play ${locale} title`, title, 30);
  checkLimit(`Google Play ${locale} short description`, shortDescription, 80);
  checkLimit(`Google Play ${locale} full description`, fullDescription, 4000);
  checkSearchNames(`Google Play ${locale}`, `${title}\n${shortDescription}\n${fullDescription}`);
}

if (errors.length > 0) {
  console.error(`Store metadata validation failed:\n- ${errors.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log('Store metadata is valid for 5 App Store and 5 Google Play localizations.');
}
