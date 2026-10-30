/// <reference types="@cloudflare/workers-types" />

import { normalizeDetails } from './property-details.mjs';
import { handleMedia, imageResponse } from './media.mjs';

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  MEDIA?: R2Bucket;
  APP_NAME: string;
  PUBLIC_SITE: string;
  SESSION_SECRET?: string;
}

const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

const COOKIE = 'bgv_session';
const SESSION_HOURS = 12;

/* ── crypto helpers (WebCrypto, no deps) ─────────────────────────── */
async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function hashPassword(password: string, salt: string): Promise<string> {
  // PBKDF2-SHA256, 100k iterations
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 100000 }, key, 256);
  return `pbkdf2$100000$${salt}$${[...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('')}`;
}
export const makePasswordHash = (pw: string) => hashPassword(pw, crypto.randomUUID());
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [scheme, iters, salt, hex] = stored.split('$');
  if (scheme !== 'pbkdf2') return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: Number(iters) }, key, 256);
  const calc = [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
  return calc === hex;
}
const uuid = () => crypto.randomUUID();
const cookieHeader = (id: string, maxAge: number) =>
  `${COOKIE}=${id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;

async function getSession(req: Request, env: Env) {
  const m = /bgv_session=([\w-]+)/.exec(req.headers.get('cookie') || '');
  if (!m) return null;
  const row = await env.DB.prepare(
    `SELECT s.id sid, s.expires_at, u.id, u.email, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND u.status = 'active'`
  ).bind(m[1]).first<Record<string, unknown>>();
  const expiry = row ? Date.parse(String(row.expires_at).replace(' ', 'T') + 'Z') : NaN;
  if (!Number.isFinite(expiry) || expiry <= Date.now()) return null;
  return { sid: row.sid as string, user: { id: row.id, email: row.email, name: row.name, role: row.role } };
}
const CAN_PUBLISH = new Set(['super_admin', 'property_manager']);
const EDIT_ROLES = new Set(['super_admin', 'property_manager', 'listing_editor', 'agent']);
const WRITE_ROLES = new Set(['super_admin', 'property_manager', 'listing_editor']);

const PRIVATE_KEYS = ['owner_name','owner_phone','owner_email','internal_notes','internal_ref','agreement_ref','follow_up_date'];
function publicProperty(p: Record<string, unknown>) {
  const { ...rest } = p;
  for (const k of PRIVATE_KEYS) delete rest[k];
  return rest;
}
function slugify(t: string) {
  return t.toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]+/g, '-').replace(/^-+|-+$/g, '') || uuid().slice(0, 8);
}
async function audit(env: Env, userId: number | null, action: string, entity = '', entityId = '', detail = '', req?: Request) {
  await env.DB.prepare('INSERT INTO audit_logs (user_id, action, entity, entity_id, detail, ip) VALUES (?,?,?,?,?,?)')
    .bind(userId, action, entity, entityId, detail.slice(0, 500), req?.headers.get('cf-connecting-ip') || '').run();
}

/* ── main router ──────────────────────────────────────────────────── */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && path !== '/api/analytics/events') {
      const origin = req.headers.get('origin');
      if ((origin && origin !== url.origin) || req.headers.get('sec-fetch-site') === 'cross-site') return json({ error: 'Cross-site request rejected' }, 403);
    }

    // CORS preflight for public read-only and analytics endpoints
    if (method === 'OPTIONS' && (path.startsWith('/api/public/') || path === '/api/analytics/events')) {
      return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' } });
    }

    // Security headers
    const H = {
      'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
      'referrer-policy': 'strict-origin-when-cross-origin',
    };
    // Public GET/ingest responses are readable cross-origin (no credentials involved)
    const PUB = { 'access-control-allow-origin': '*' };
    const J = (d: unknown, s = 200, h: HeadersInit = {}) => json(d, s, { ...H, ...h });

    // ── public pages: serve admin SPA shell ──
    if (method === 'GET' && (path === '/' || path === '/admin')) {
      const html = await env.ASSETS.fetch(new Request(`${url.origin}/index.html`, req)).catch(() => null);
      return new Response(html ? await html.text() : '<h1>BG Venture Admin</h1>', {
        headers: { 'content-type': 'text/html; charset=utf-8', ...H },
      });
    }

    // ── AUTH ──
    if (path === '/api/auth/login' && method === 'POST') {
      const { email, password } = await req.json().catch(() => ({})) as { email?: string; password?: string };
      if (!email || !password) return J({ error: 'Email and password required' }, 400);
      const user = await env.DB.prepare('SELECT * FROM users WHERE email = ? AND status = \'active\'').bind(email.toLowerCase()).first<Record<string, unknown>>();
      if (!user) return J({ error: 'Invalid credentials' }, 401);
      if (user.locked_until && new Date(String(user.locked_until)) > new Date())
        return J({ error: 'Account temporarily locked. Try again later.' }, 429);
      const ok = await verifyPassword(password, String(user.password_hash));
      if (!ok) {
        const fails = Number(user.failed_logins) + 1;
        const lock = fails >= 5 ? `datetime('now','+15 minutes')` : null;
        await env.DB.prepare(`UPDATE users SET failed_logins = ?, locked_until = ${lock ? lock : 'NULL'} WHERE id = ?`).bind(fails, user.id).run();
        return J({ error: 'Invalid credentials' }, 401);
      }
      const sid = uuid();
      const exp = new Date(Date.now() + SESSION_HOURS * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
      await env.DB.batch([
        env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?,?,?)').bind(sid, user.id, exp),
        env.DB.prepare("UPDATE users SET failed_logins = 0, locked_until = NULL, last_login = datetime('now') WHERE id = ?").bind(user.id),
      ]);
      await audit(env, Number(user.id), 'login', 'user', String(user.id), '', req);
      return J({ user: { email: user.email, name: user.name, role: user.role } }, 200, { 'set-cookie': cookieHeader(sid, SESSION_HOURS * 3600) });
    }
    if (path === '/api/auth/logout' && method === 'POST') {
      const s = await getSession(req, env);
      if (s) { await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(s.sid).run(); await audit(env, Number(s.user.id), 'logout'); }
      return J({ ok: true }, 200, { 'set-cookie': cookieHeader('gone', 0) });
    }
    if (path === '/api/auth/session' && method === 'GET') {
      const s = await getSession(req, env);
      return s ? J({ user: s.user }) : J({ user: null }, 401);
    }

    // ── ANALYTICS ingest (public) ──
    if (path === '/api/analytics/events' && method === 'POST') {
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const event = String(b.event || '').slice(0, 60);
      const ALLOWED = new Set(['page_view','session_start','property_list_view','property_card_impression','property_card_click','property_detail_view','property_gallery_interaction','property_search','property_filter_applied','property_sort_applied','inquiry_button_click','whatsapp_click','phone_click','email_click','contact_form_start','contact_form_submit','map_open','similar_property_click','external_link_click']);
      if (!ALLOWED.has(event)) return J({ error: 'Invalid event' }, 400);
      const device = /Mobi|Android/i.test(req.headers.get('user-agent') || '') ? 'mobile' : /Tablet|iPad/i.test(req.headers.get('user-agent') || '') ? 'tablet' : 'desktop';
      await env.DB.prepare(
        `INSERT INTO analytics_events (event, property_id, session_id, page, referrer, utm_source, utm_medium, utm_campaign, device, country)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        event, b.property_id ? Number(b.property_id) : null, String(b.session_id || '').slice(0, 64) || null,
        String(b.page || '').slice(0, 300) || null, String(b.referrer || '').slice(0, 300) || null,
        String(b.utm_source || '').slice(0, 100) || null, String(b.utm_medium || '').slice(0, 100) || null,
        String(b.utm_campaign || '').slice(0, 100) || null,
        device, (req as Request & { cf?: { country?: string } }).cf?.country || null
      ).run();
      return J({ ok: true }, 202, PUB);
    }

    // ── PUBLIC properties API (published only, public fields only) ──
    if (path === '/api/public/properties' && method === 'GET') {
      const p = new URL(req.url).searchParams;
      const cond: string[] = ["status = 'published'", "availability = 'available'"];
      const args: unknown[] = [];
      if (p.get('purpose')) { cond.push('listing_type = ?'); args.push(p.get('purpose') === 'rent' ? 'rent' : 'sale'); }
      if (p.get('category')) { cond.push('category = ?'); args.push(p.get('category')); }
      if (p.get('type')) { cond.push('property_type = ?'); args.push(p.get('type')); }
      if (p.get('community')) { cond.push('community = ?'); args.push(p.get('community')); }
      if (p.get('city')) { cond.push('city = ?'); args.push(p.get('city')); }
      if (p.get('bedrooms')) { cond.push('bedrooms = ?'); args.push(p.get('bedrooms')); }
      const rows = await env.DB.prepare(
        `SELECT id, ref, slug, title, listing_type, category, property_type, community, subcommunity, city, emirate,
                bedrooms, bathrooms, area_sqft, furnishing, sale_price, annual_rent, monthly_rent, currency,
                featured, view_type, parking, balcony,
                (SELECT i.id FROM property_images i WHERE i.property_id=properties.id AND i.approved=1 AND i.deleted_at IS NULL ORDER BY i.is_main DESC,i.position,i.id LIMIT 1) cover_image_id
         FROM properties WHERE ${cond.join(' AND ')} ORDER BY featured DESC, id DESC LIMIT 100`
      ).bind(...args).all();
      return J({ properties: rows.results }, 200, PUB);
    }

    const publicImage = path.match(/^\/api\/public\/properties\/(\d+)\/media\/(\d+)$/);
    if (publicImage && method === 'GET') {
      const image = await env.DB.prepare("SELECT i.* FROM property_images i JOIN properties p ON p.id=i.property_id WHERE p.id=? AND i.id=? AND p.status='published' AND p.availability='available' AND i.approved=1 AND i.deleted_at IS NULL").bind(Number(publicImage[1]), Number(publicImage[2])).first();
      if (!image) return J({ error: 'Not found' }, 404);
      const r = await imageResponse(env, image);
      r.headers.set('access-control-allow-origin', '*');
      r.headers.set('cache-control', 'public, max-age=3600');
      return r;
    }

    const publicDetail = path.match(/^\/api\/public\/properties\/(\d+)$/);
    if (publicDetail && method === 'GET') {
      const prop = await env.DB.prepare(
        `SELECT id, ref, slug, title, description, short_description, listing_type, category, property_type,
                community, subcommunity, city, emirate, building, bedrooms, bathrooms, area_sqft, area_sqm,
                furnishing, parking, balcony, view_type, currency, sale_price, annual_rent, monthly_rent,
                featured, completion, developer, project_name, seo_title, seo_description, details_json, updated_at
         FROM properties WHERE id = ? AND status = 'published' AND availability = 'available'`
      ).bind(Number(publicDetail[1])).first<Record<string, unknown>>();
      if (!prop) return J({ error: 'Not found' }, 404, PUB);
      const images = await env.DB.prepare(
        `SELECT id, caption, alt_text, image_category, width, height, is_main, position
         FROM property_images WHERE property_id = ? AND approved = 1 AND deleted_at IS NULL ORDER BY is_main DESC, position, id`
      ).bind(Number(publicDetail[1])).all();
      let details: Record<string, unknown> = {};
      try { details = JSON.parse(String(prop.details_json || '{}')); } catch { details = {}; }
      const places = Array.isArray(details.nearby_places) ? (details.nearby_places as Record<string, unknown>[]).filter(pl => pl.verified === true && pl.public === true) : [];
      delete prop.details_json;
      return J({
        property: prop,
        images: images.results,
        details: {
          map_url: details.map_url ?? null,
          amenities: details.amenities ?? [],
          measurements: details.measurements ?? [],
          nearby_supermarkets: details.nearby_supermarkets ?? null,
          nearby_facilities: details.nearby_facilities ?? null,
          nearby_places: places,
        },
      }, 200, PUB);
    }

    // ── everything below requires session ──
    const session = await getSession(req, env);
    if (!session) return J({ error: 'Authentication required' }, 401);
    const role = String(session.user.role);
    const me = Number(session.user.id);
    const mediaRoute = path.match(/^\/api\/admin\/properties\/(\d+)\/media(?:\/(\d+))?$/);
    if (mediaRoute) return handleMedia(req, env, session, Number(mediaRoute[1]), mediaRoute[2] ? Number(mediaRoute[2]) : null, J);

    // PROPERTIES list
    if (path === '/api/admin/properties' && method === 'GET') {
      if (!EDIT_ROLES.has(role) && role !== 'analytics_viewer') return J({ error: 'Forbidden' }, 403);
      const p = url.searchParams;
      const cond: string[] = ['1=1']; const args: unknown[] = [];
      if (role === 'agent') { cond.push('agent_id = ?'); args.push(me); }
      for (const [k, col] of [['status','status'],['listing_type','listing_type'],['category','category'],['community','community'],['furnishing','furnishing'],['availability','availability']] as const)
        if (p.get(k)) { cond.push(`${col} = ?`); args.push(p.get(k)); }
      if (p.get('min_price')) { cond.push('(sale_price >= ? OR annual_rent >= ?)'); args.push(Number(p.get('min_price')), Number(p.get('min_price'))); }
      if (p.get('max_price')) { cond.push('(sale_price <= ? OR annual_rent <= ?)'); args.push(Number(p.get('max_price')), Number(p.get('max_price'))); }
      if (p.get('bedrooms')) { cond.push('bedrooms = ?'); args.push(p.get('bedrooms')); }
      if (p.get('agent_id') && role === 'super_admin') { cond.push('agent_id = ?'); args.push(Number(p.get('agent_id'))); }
      if (p.get('q')) { cond.push('(title LIKE ? OR ref LIKE ? OR community LIKE ? OR building LIKE ?)'); args.push(`%${p.get('q')}%`, `%${p.get('q')}%`, `%${p.get('q')}%`, `%${p.get('q')}%`); }
      const page = Math.max(1, Number(p.get('page') || 1)); const size = Math.min(50, Number(p.get('size') || 20));
      const total = await env.DB.prepare(`SELECT COUNT(*) c FROM properties WHERE ${cond.join(' AND ')}`).bind(...args).first<{ c: number }>();
      const rows = await env.DB.prepare(
        `SELECT properties.id, ref, title, listing_type, category, property_type, community, building, city,
                sale_price, annual_rent, monthly_rent, currency, bedrooms, bathrooms, area_sqft,
                furnishing, status, availability, featured, agent_id, properties.created_at, properties.updated_at,
                (SELECT name FROM users u WHERE u.id = properties.agent_id) agent_name,
                (SELECT email FROM users u WHERE u.id = properties.agent_id) agent_email,
                (SELECT i.id FROM property_images i WHERE i.property_id = properties.id AND i.deleted_at IS NULL ORDER BY i.is_main DESC, i.position, i.id LIMIT 1) cover_image_id
         FROM properties WHERE ${cond.join(' AND ')} ORDER BY updated_at DESC LIMIT ? OFFSET ?`
      ).bind(...args, size, (page - 1) * size).all();
      return J({ properties: rows.results, total: total?.c ?? 0, page, size });
    }

    // PROPERTY create
    if (path === '/api/admin/properties' && method === 'POST') {
      if (!WRITE_ROLES.has(role)) return J({ error: 'Forbidden' }, 403);
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      if (!b.title || !b.listing_type || !b.category || !b.property_type)
        return J({ error: 'title, listing_type, category, property_type are required' }, 400);
      if (!['sale','rent','off_plan'].includes(String(b.listing_type))) return J({ error: 'Invalid listing_type' }, 400);
      for (const f of ['sale_price','annual_rent','monthly_rent','deposit','service_charges'])
        if (b[f] != null && Number(b[f]) < 0) return J({ error: `${f} cannot be negative` }, 400);
      let details;
      try { details = normalizeDetails(b); } catch (e) { return J({ error: (e as Error).message }, 400); }
      const ref = `BGV-${uuid().replaceAll('-', '').slice(0, 16).toUpperCase()}`;
      const slug = await uniqueSlug(env, slugify(String(b.title)));
      const r = await env.DB.prepare(
        `INSERT INTO properties (ref, slug, title, description, short_description, listing_type, category, property_type,
           status, featured, availability, emirate, city, community, subcommunity, building, street,
           bedrooms, bathrooms, area_sqft, furnishing, parking, balcony, view_type, completion,
           currency, sale_price, annual_rent, monthly_rent, deposit, service_charges, pricing_notes,
           developer, project_name, expected_completion, payment_plan,
           owner_name, owner_phone, owner_email, internal_ref, internal_notes, agreement_ref,
           agent_id, seo_title, seo_description, keywords, created_by, area_sqm, latitude, longitude, floor, details_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        ref, slug, b.title, b.description ?? null, b.short_description ?? null, b.listing_type, b.category, b.property_type,
        'draft',
        b.featured ? 1 : 0, b.availability ?? 'available', b.emirate ?? 'Dubai', b.city ?? null, b.community ?? null,
        b.subcommunity ?? null, b.building ?? null, b.street ?? null,
        b.bedrooms ?? null, b.bathrooms ?? null, b.area_sqft ?? null, b.furnishing ?? null,
        b.parking ?? null, b.balcony ? 1 : 0, b.view_type ?? null, b.completion ?? null,
        b.currency ?? 'AED', b.sale_price ?? null, b.annual_rent ?? null, b.monthly_rent ?? null,
        b.deposit ?? null, b.service_charges ?? null, b.pricing_notes ?? null,
        b.developer ?? null, b.project_name ?? null, b.expected_completion ?? null, b.payment_plan ?? null,
        b.owner_name ?? null, b.owner_phone ?? null, b.owner_email ?? null,
        b.internal_ref ?? null, b.internal_notes ?? null, b.agreement_ref ?? null,
        b.agent_id ?? me, b.seo_title ?? null, b.seo_description ?? null, b.keywords ?? null, me,
        b.area_sqm ?? null, b.latitude ?? null, b.longitude ?? null, b.floor ?? null, JSON.stringify(details)
      ).run();
      await audit(env, me, 'property.create', 'property', ref, String(b.title), req);
      return J({ id: r.meta.last_row_id, ref, slug }, 201);
    }

    // PROPERTY detail / update / actions
    const mProp = path.match(/^\/api\/admin\/properties\/(\d+)(?:\/(publish|archive|duplicate|restore))?$/);
    if (mProp) {
      if (!EDIT_ROLES.has(role)) return J({ error: 'Forbidden' }, 403);
      const id = Number(mProp[1]); const action = mProp[2];
      const prop = await env.DB.prepare('SELECT * FROM properties WHERE id = ?').bind(id).first<Record<string, unknown>>();
      if (!prop) return J({ error: 'Not found' }, 404);
      if (role === 'agent' && Number(prop.agent_id) !== me) return J({ error: 'Forbidden' }, 403);
      if (action && !WRITE_ROLES.has(role)) return J({ error: 'Forbidden' }, 403);
      if (!action && method === 'GET') {
        const images = await env.DB.prepare('SELECT * FROM property_images WHERE property_id = ? AND deleted_at IS NULL ORDER BY position').bind(id).all();
        return J({ property: role === 'agent' ? publicProperty(prop) : prop, images: images.results });
      }
      if (!action && method === 'PATCH') {
        const b = await req.json().catch(() => ({})) as Record<string, unknown>;
        const allowed = ['title','description','short_description','listing_type','category','property_type','featured','availability','emirate','city','community','subcommunity','building','street','bedrooms','bathrooms','area_sqft','furnishing','parking','balcony','view_type','completion','currency','sale_price','annual_rent','monthly_rent','deposit','service_charges','pricing_notes','developer','project_name','expected_completion','payment_plan','owner_name','owner_phone','owner_email','internal_ref','internal_notes','agreement_ref','agent_id','seo_title','seo_description','keywords'];
        let details;
        try { details = normalizeDetails(b); } catch (e) { return J({ error: (e as Error).message }, 400); }
        allowed.push('area_sqm', 'latitude', 'longitude', 'floor');
        if (role === 'agent') {
          for (const k of [...PRIVATE_KEYS, 'agent_id']) if (k in b) return J({ error: 'Restricted field' }, 403);
        }
        const sets: string[] = []; const args: unknown[] = [];
        if (Object.keys(details).length) { sets.push('details_json = ?'); args.push(JSON.stringify({ ...JSON.parse(String(prop.details_json || '{}')), ...details })); }
        for (const k of allowed) if (k in b) { sets.push(`${k} = ?`); args.push(b[k]); }
        if (!sets.length) return J({ error: 'Nothing to update' }, 400);
        await env.DB.prepare(`UPDATE properties SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).bind(...args, id).run();
        await audit(env, me, 'property.update', 'property', String(id), '', req);
        return J({ ok: true });
      }
      if (action === 'publish' && method === 'POST') {
        if (!CAN_PUBLISH.has(role)) return J({ error: 'Insufficient permission to publish' }, 403);
        const missing = ['title','listing_type','category','property_type','community'].filter(f => !prop[f]);
        if (missing.length) return J({ error: `Required before publishing: ${missing.join(', ')}` }, 400);
        await env.DB.prepare("UPDATE properties SET status = 'published', updated_at = datetime('now') WHERE id = ?").bind(id).run();
        await audit(env, me, 'property.publish', 'property', String(id), '', req);
        return J({ ok: true });
      }
      if ((action === 'archive' || action === 'restore') && method === 'POST') {
        if (!CAN_PUBLISH.has(role)) return J({ error: 'Forbidden' }, 403);
        await env.DB.prepare(`UPDATE properties SET status = ?, updated_at = datetime('now') WHERE id = ?`).bind(action === 'archive' ? 'archived' : 'draft', id).run();
        await audit(env, me, `property.${action}`, 'property', String(id), '', req);
        return J({ ok: true });
      }
      if (action === 'duplicate' && method === 'POST') {
        const newRef = `BGV-${uuid().replaceAll('-', '').slice(0, 16).toUpperCase()}`;
        const slug = await uniqueSlug(env, `${prop.slug}-copy`);
        const cols = 'slug,title,description,short_description,listing_type,category,property_type,availability,emirate,city,community,subcommunity,building,street,bedrooms,bathrooms,area_sqft,furnishing,parking,balcony,view_type,completion,currency,sale_price,annual_rent,monthly_rent,deposit,service_charges,pricing_notes,developer,project_name,expected_completion,payment_plan,owner_name,owner_phone,owner_email,internal_ref,internal_notes,agreement_ref,agent_id,seo_title,seo_description,keywords';
        const copyColumns = `${cols},area_sqm,latitude,longitude,floor,details_json`;
        await env.DB.prepare(`INSERT INTO properties (ref,${copyColumns},status,created_by) SELECT ?,?,${copyColumns.split(',').slice(1).join(',')},'draft',? FROM properties WHERE id = ?`).bind(newRef, slug, me, id).run();
        await audit(env, me, 'property.duplicate', 'property', String(id), '', req);
        return J({ ok: true, ref: newRef });
      }
      return J({ error: 'Unsupported' }, 405);
    }

    // DASHBOARD overview
    if (path === '/api/admin/analytics/overview' && method === 'GET') {
      const inv = await env.DB.prepare(`SELECT
        COUNT(*) total,
        SUM(status='published') published, SUM(status='draft') drafts, SUM(status='pending') pending,
        SUM(status='reserved') reserved, SUM(status='rented') rented, SUM(status='sold') sold, SUM(status='archived') archived,
        SUM(availability='available') available,
        SUM(listing_type='sale') for_sale, SUM(listing_type='rent') for_rent, SUM(listing_type='off_plan') off_plan
        FROM properties`).first();
      const days = Math.min(90, Number(url.searchParams.get('days') || 30));
      const ev = await env.DB.prepare(`SELECT
        COUNT(*) events, COUNT(DISTINCT session_id) sessions,
        SUM(event='page_view') page_views, SUM(event='property_detail_view') property_views,
        SUM(event='whatsapp_click') whatsapp, SUM(event='phone_click') phone,
        SUM(event='email_click') email, SUM(event='contact_form_submit') inquiries
        FROM analytics_events WHERE created_at >= datetime('now', ?)`).bind(`-${days} days`).first();
      return J({ inventory: inv, analytics: ev, period_days: days });
    }
    if (path === '/api/admin/analytics/properties' && method === 'GET') {
      const days = Math.min(90, Number(url.searchParams.get('days') || 30));
      const rows = await env.DB.prepare(`SELECT p.id, p.ref, p.title,
        SUM(e.event='property_detail_view') views,
        SUM(e.event='property_card_impression') impressions,
        SUM(e.event='property_card_click') clicks,
        SUM(e.event='whatsapp_click') whatsapp, SUM(e.event='phone_click') phone, SUM(e.event='email_click') email,
        SUM(e.event='contact_form_submit') inquiries
        FROM properties p LEFT JOIN analytics_events e ON e.property_id = p.id AND e.created_at >= datetime('now', ?)
        GROUP BY p.id ORDER BY views DESC LIMIT 50`).bind(`-${days} days`).all();
      return J({ properties: rows.results, period_days: days });
    }

    // INQUIRIES
    if (path === '/api/admin/inquiries' && method === 'GET') {
      if (!CAN_PUBLISH.has(role) && role !== 'agent') return J({ error: 'Forbidden' }, 403);
      const rows = await env.DB.prepare(
        `SELECT i.*, p.title property_title, p.ref property_ref FROM inquiries i
         LEFT JOIN properties p ON p.id = i.property_id WHERE (? = 0 OR i.assigned_agent = ?) ORDER BY i.id DESC LIMIT 200`).bind(role === 'agent' ? 1 : 0, me).all();
      return J({ inquiries: rows.results });
    }
    const mInq = path.match(/^\/api\/admin\/inquiries\/(\d+)$/);
    if (mInq && method === 'PATCH') {
      if (!CAN_PUBLISH.has(role) && role !== 'agent') return J({ error: 'Forbidden' }, 403);
      const inquiry = await env.DB.prepare('SELECT assigned_agent FROM inquiries WHERE id = ?').bind(Number(mInq[1])).first<{ assigned_agent: number }>();
      if (!inquiry) return J({ error: 'Not found' }, 404);
      if (role === 'agent' && inquiry.assigned_agent !== me) return J({ error: 'Forbidden' }, 403);
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      if (role === 'agent' && 'assigned_agent' in b) return J({ error: 'Forbidden' }, 403);
      if (b.status && !['new','contacted','follow_up','qualified','closed','spam'].includes(String(b.status)))
        return J({ error: 'Invalid status' }, 400);
      const sets: string[] = []; const args: unknown[] = [];
      for (const k of ['status','assigned_agent','follow_up_date','internal_notes']) if (k in b) { sets.push(`${k} = ?`); args.push(b[k]); }
      if (!sets.length) return J({ error: 'Nothing to update' }, 400);
      await env.DB.prepare(`UPDATE inquiries SET ${sets.join(', ')} WHERE id = ?`).bind(...args, Number(mInq[1])).run();
      await audit(env, me, 'inquiry.update', 'inquiry', mInq[1], '', req);
      return J({ ok: true });
    }

    // USERS (super_admin only)
    if (path === '/api/admin/users' && method === 'POST') {
      if (role !== 'super_admin') return J({ error: 'Forbidden' }, 403);
      const b = await req.json().catch(() => ({})) as Record<string, string>;
      if (!b.email || !b.password || !b.name || !b.role) return J({ error: 'email, password, name, role required' }, 400);
      if (!['super_admin','property_manager','listing_editor','agent','analytics_viewer'].includes(b.role))
        return J({ error: 'Invalid role' }, 400);
      const hash = await makePasswordHash(b.password);
      try {
        await env.DB.prepare('INSERT INTO users (email, password_hash, name, role) VALUES (?,?,?,?)')
          .bind(b.email.toLowerCase(), hash, b.name, b.role).run();
      } catch { return J({ error: 'Email already exists' }, 409); }
      await audit(env, me, 'user.create', 'user', b.email, b.role, req);
      return J({ ok: true }, 201);
    }
    if (path === '/api/admin/users' && method === 'GET') {
      if (role !== 'super_admin') return J({ error: 'Forbidden' }, 403);
      const rows = await env.DB.prepare('SELECT id, email, name, role, status, last_login, created_at FROM users ORDER BY id').all();
      return J({ users: rows.results });
    }

    // AUDIT LOGS
    if (path === '/api/admin/audit-logs' && method === 'GET') {
      if (role !== 'super_admin') return J({ error: 'Forbidden' }, 403);
      const rows = await env.DB.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 300').all();
      return J({ logs: rows.results });
    }

    return J({ error: 'Not found' }, 404);
  },
};

async function uniqueSlug(env: Env, base: string): Promise<string> {
  let slug = base; let n = 1;
  while (await env.DB.prepare('SELECT id FROM properties WHERE slug = ?').bind(slug).first()) slug = `${base}-${++n}`;
  return slug;
}
