# BG Venture Properties — Admin Back Office

Secure property-management and website-analytics back office for BG Venture Properties,
separate from the public storefront (bgventureproperties.ae).

## Stack

- **Cloudflare Worker** (`src/worker.ts`) — auth, REST API, security headers
- **Cloudflare D1** (`migrations/0001_init.sql`) — users, sessions, properties,
  images, amenities, locations, inquiries, analytics events, audit logs, settings
- **Admin SPA** (`admin/index.html`) — login, dashboard, properties, add-property,
  property analytics, inquiries, users
- **Cloudflare R2** — media storage (binding ready, upload endpoints in a later phase)

## Implemented (Phase 2–3 foundation)

- PBKDF2-hashed passwords, HttpOnly/Secure/SameSite session cookies, 12h expiry
- Login rate limiting (5 fails → 15 min lock), audit logging, role enforcement on the server
- Roles: super_admin, property_manager, listing_editor, agent, analytics_viewer
- Properties: create (validated), list/search/paginate, publish (permission-gated),
  archive/restore, duplicate, unique refs `BGV-*`, unique slugs
- Private fields (owner details, internal notes) never leave via public API
- Public API `GET /api/public/properties` — published only, filterable
- Analytics: `POST /api/analytics/events` (validated event names, device + country from CF),
  admin overview + per-property performance (views, impressions, CTR, contact clicks)
- Inquiries table + admin endpoints

## Setup

```bash
npm install
npx wrangler d1 create bgv-admin          # paste database_id into wrangler.toml
npm run d1:local                          # apply schema locally
node scripts/create-admin.mjs admin@bgventureproperties.ae <password> "Admin"        # local
npm run dev                               # wrangler dev — http://127.0.0.1:8787
```

## Deploy

```bash
npm run d1:remote                          # apply schema to production DB
node scripts/create-admin.mjs admin@bgventureproperties.ae <password> "Admin" --remote
npm run deploy
```

Then configure the `admin.bgventureproperties.ae` custom domain/route in Cloudflare.

## Secrets & security

- No credentials in source. Use `wrangler secret put SESSION_SECRET` etc. for secrets.
- `.dev.vars` and `.env` are gitignored.
- Never commit owner documents or DB dumps.

## Roadmap (next phases)

- Property edit/detail UI, media upload to R2, full multi-section property form
- Dashboard charts (Chart.js) + date-range selectors, CSV exports
- Public storefront integration: render published listings + fire analytics events
- Password reset, MFA, inquiry creation from the public contact form, report builder
