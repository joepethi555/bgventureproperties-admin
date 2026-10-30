// Bulk-import draft properties + photos from X:\our properties into the admin system.
// Usage: node scripts/import-inventory.mjs "X:\our properties" --email admin@x --pass pw [--apply]
// Default is a dry run: it prints what would be created/uploaded. --apply writes to the live API.
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

const API = process.env.BGV_API || 'https://bgv-admin.joepethj.workers.dev';
const ROOT = process.argv[2] || 'X:\\our properties';
const APPLY = process.argv.includes('--apply');
const arg = n => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
const EMAIL = arg('--email'), PASS = arg('--pass');
const IMG_EXT = new Set(['.jpeg', '.jpg', '.png']);

// Path segments that indicate administrative/private records, never listing media.
const PRIVATE_DIR = /bills?|contract|tenan|sale agreement|\bsale\b|dewa|\bdu\b|service charges|poa|documents|new folder|clients|deposit|receipt|agreement/i;
// Filenames that are documents photographed or scanned, not property photos.
const PRIVATE_FILE = /passport|visa|emirates|\bid\b|poa|login|account|cheque|check|receipt|contract|deed|ejari|dewa|bill|invoice|bank|cost|soa|noc|form|scan|letter|deposit|payment|evalu|fee\b|title|tittle|move ?in|insur|trade|licen|gas\b|damage|maintenance|clearance|addendum|renewal|rent details|quick pay|apple pay|recharge|td\b/i;
const PHOTOISH = /whatsapp image|^img[_-]|^p\d|^dsc|^photo|^\d+(\s*\(\d+\))?\.(jpe?g|png)$|floor ?plan|view|room|kitchen|living|bedroom|bath|balcony|pool|gym|lobby|exterior|building|villa|office|flat|apt|unit|area|meeting|majlis|reception/i;
// Directories that hold listing media rather than paperwork.
const PHOTO_DIR = /ads?\b|advertis|pic\b|picture|photo|image|gallery|room|area|floor|villa|office|flat|apt\b|unit|view|kitchen|bed|bath|living|pool|gym|lobby|majlis|maid|exterior|interior|building|corridor|hall\b|entrance|lift|stairs|terrace|garden|parking|reception|meeting|add\b/i;

const COMMUNITY = [[/jlt/i, 'Jumeirah Lake Towers'], [/jvc/i, 'Jumeirah Village Circle'], [/business bay/i, 'Business Bay'], [/al furjan/i, 'Al Furjan'], [/liwan/i, 'Liwan']];
const titleCase = s => s.toLowerCase().replace(/(^|[\s,])(\w)/g, (m, p, c) => p + c.toUpperCase()).replace(/Jlt/g, 'JLT').replace(/Jvc/g, 'JVC').replace(/Hds/g, 'HDS').replace(/Aa/g, 'AA').replace(/X(\d)/g, 'X$1').replace(/Th(\d)/g, 'TH$1').replace(/Glv/g, 'GLV');

function parseFolder(raw) {
  const name = raw.replace(/\s+/g, ' ').trim();
  const kind = /^(APT|OFFICE|VILLA)\s+/i.exec(name)?.[1].toUpperCase();
  if (!kind) return null;
  let rest = name.slice(kind.length).trim();
  let bedrooms = null;
  const bed = /\(([^)]*)\)\s*$/.exec(rest);
  if (bed) {
    const tag = bed[1].toUpperCase();
    bedrooms = tag.includes('STUDIO') ? 'Studio' : (tag.match(/\d+/) || [null])[0];
    rest = rest.slice(0, bed.index).trim();
  }
  const community = COMMUNITY.find(([re]) => re.test(rest))?.[1] || null;
  // building = text before the final unit token(s); unit = trailing token like 3108 / UNIT 4,D
  let unit = null, building = rest;
  const um = /\bUNIT\s+(.+)$/i.exec(rest);
  if (um) { unit = um[1].trim(); building = rest.slice(0, um.index).trim(); }
  else { const tm = /\s([A-Z]?\d[\d,A-Z]*)$/.exec(rest); if (tm) { unit = tm[1]; building = rest.slice(0, tm.index).trim(); } }
  building = building.replace(/^(JLT|JVC|BUSINESS BAY|AL FURJAN|LIWAN)\s*-\s*/i, '').trim();
  building = titleCase(building.replace(/-$/, '').replace(/^-/, '').trim());
  const typeLabel = kind === 'APT' ? 'Apartment' : kind === 'OFFICE' ? 'Office' : 'Villa';
  const title = `${typeLabel} ${unit || ''} ${building}${community ? ', ' + community : ''}`.replace(/\s+/g, ' ').trim();
  return {
    title, listing_type: kind === 'OFFICE' || kind === 'VILLA' ? 'rent' : 'sale',
    category: kind === 'OFFICE' ? 'Commercial' : 'Residential',
    property_type: typeLabel, community, building, city: 'Dubai', bedrooms,
  };
}

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else yield p;
  }
}

const cookie = { v: '' };
async function api(path, method = 'GET', body, headers = {}) {
  const r = await fetch(API + '/api' + path, {
    method,
    headers: { cookie: cookie.v, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = r.headers.get('set-cookie'); if (set) cookie.v = set.split(';')[0];
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path}: ${d.error || r.status}`);
  return d;
}

const dirs = readdirSync(ROOT, { withFileTypes: true }).filter(d => d.isDirectory() && !/not managed by us/i.test(d.name));
const plan = [];
for (const d of dirs) {
  const info = parseFolder(d.name);
  if (!info) { console.log(`SKIP (unparsed): ${d.name}`); continue; }
  const photos = [], skipped = [];
  for (const f of walk(join(ROOT, d.name))) {
    const rel = f.slice(join(ROOT, d.name).length + 1);
    if (!IMG_EXT.has(extname(f).toLowerCase())) continue;
    const dirPart = rel.slice(0, rel.length - basename(f).length);
    if (PRIVATE_DIR.test(dirPart) || PRIVATE_FILE.test(basename(f))) { skipped.push(rel); continue; }
    if (!PHOTOISH.test(basename(f)) && !PHOTO_DIR.test(dirPart)) { skipped.push(rel + '  (unrecognised name)'); continue; }
      photos.push(f);
  }
  plan.push({ folder: d.name, info, photos, skipped });
}

const SHOW = arg('--show-skipped');
let total = 0;
for (const p of plan) {
  const mb = p.photos.reduce((s, f) => s + statSync(f).size, 0) / 1048576;
  total += p.photos.length;
  console.log(`${p.info.title}\n  listing=${p.info.listing_type} type=${p.info.property_type} community=${p.info.community || '-'} building=${p.info.building} beds=${p.info.bedrooms || '-'}\n  photos=${p.photos.length} (${mb.toFixed(0)} MB) skipped=${p.skipped.length}`);
  if (SHOW && p.folder.replace(/\s+/g, ' ').toUpperCase().includes(SHOW.toUpperCase())) for (const s of p.skipped.slice(0, 60)) console.log('    - ' + s);
}
console.log(`\n${plan.length} properties, ${total} photos${APPLY ? '' : ' — DRY RUN, pass --apply to write'}`);
if (!APPLY) process.exit(0);

await api('/auth/login', 'POST', { email: EMAIL, password: PASS });
const existing = await api('/admin/properties?size=50');
const byTitle = new Map(existing.properties.map(p => [p.title, p.id]));
for (const p of plan) {
  let id = byTitle.get(p.info.title);
  if (!id) {
    const r = await api('/admin/properties', 'POST', p.info);
    id = r.id; console.log(`created #${id} ${p.info.title}`);
  } else console.log(`exists #${id} ${p.info.title}`);
  const have = (await api(`/admin/properties/${id}/media`)).images.length;
  if (have > 0 && !process.argv.includes('--reupload')) { console.log(`  already has ${have} image(s) — skipping uploads`); continue; }
  let ok = 0, fail = 0;
  for (const f of p.photos) {
    try {
      const buf = readFileSync(f);
      const r = await fetch(`${API}/api/admin/properties/${id}/media`, {
        method: 'POST',
        headers: { cookie: cookie.v, 'content-type': extname(f).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg', 'x-filename': basename(f).replace(/[^a-zA-Z0-9_. -]/g, '_') },
        body: buf,
      });
      if (r.ok) ok++; else { fail++; console.log(`  FAIL ${basename(f)}: ${(await r.json().catch(() => ({}))).error || r.status}`); }
    } catch (e) { fail++; console.log(`  FAIL ${basename(f)}: ${e.message}`); }
  }
  console.log(`  uploaded ${ok}, failed ${fail}`);
}
console.log('Done.');

