# BG Venture Properties — Admin Back Office

Secure property-management and website-analytics back office for BG Venture Properties,
separate from the public storefront (bgventureproperties.ae).

## Stack

- **Cloudflare Worker** (`src/worker.ts`) — auth, REST API, security headers
- **Cloudflare D1** (`migrations/0001_init.sql`) — users, sessions, properties,
  images, amenities, locations, inquiries, analytics events, audit logs, settings
- **Admin SPA** (`admin/index.html`) — login, dashboard, properties, add-property,
  property analytics, inquiries, users
- **Cloudflare R2** — private media bucket bgv-admin-media, served through authorized Worker endpoints

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

## Property intelligence audit — 2026-10-30

Read-only production D1 queries confirmed zero properties, zero images, zero
locations and zero analytics events. Duplicate references, inconsistent property
names, invalid coordinates, broken media references and unit discrepancies cannot
be assessed against actual inventory until records are entered. No property files
were imported. The accessible X:\\our properties folder contains 28 directories.

Existing tables: users (accounts), sessions (authentication), properties (inventory),
property_images (media metadata), amenities (options), property_amenities (links),
locations (hierarchy), inquiries (contacts), analytics_events (events), audit_logs
(account and inventory activity), settings (configuration). References and slugs
already have unique constraints. Status, listing type, category, community and price
indexes exist; analytics indexes cover event/time, property/time and session.

| Severity | Verified finding | First-upgrade response / remaining action |
| --- | --- | --- |
| Critical | Agent property access was not assignment-scoped; inquiry endpoints lacked role checks | Server checks added; regression tests included |
| High | Table text used unescaped HTML interpolation | Escape dynamic table values before rendering |
| High | Create SQL placeholder count and duplicate SQL bindings were inconsistent | Corrected and exercised against SQLite |
| High | No explicit cross-origin write rejection | Origin and Fetch Metadata checks added |
| High | Initial R2 account API returned code 10042 | Resolved after owner enablement; bgv-admin-media created and bound |
| High | No provider connection for nearby discovery | Manual sourced entries only; automatic lookup remains unavailable |
| High | Analytics intake lacks full consent, deduplication and abuse controls | Not production-complete; implement before storefront instrumentation |
| Medium | Public search uses static options and a placeholder results screen | Storefront integration still pending |
| Medium | Location rows and relationships unused | Structured location management and verification pending |
| Medium | Time-based short property references could collide | New references use 16 UUID hexadecimal characters plus the unique constraint |
| Medium | Password recovery, MFA and password rotation UI missing | Authentication lifecycle work remains; rotate credentials previously shared in chat |
| Low | Initial amenity SQL used a double-quoted string | Corrected for portable SQLite execution |

## First upgrade functionality

- Add/edit property details, manual Google Maps link and validated coordinates.
- Area conversion uses 10.7639104167 sqft per sqm. Original measurement value,
  input unit and measurement kind are retained in details_json. Additional plot,
  internal, balcony and built-up measurements remain distinct. Blank is unknown.
- Manual nearby-place rows: category, coordinates, source, verification date,
  review state and public approval. Public approval requires verification evidence.
- Haversine straight-line distances use Earth mean radius 6,371,008.8 m;
  they are not driving distances or travel-time estimates.
- Form supports confirmed building amenities and a user-supplied Candace Aster
  template. It does not auto-save, import confidential documents or include a price.
- All creates start as drafts. Publish uses the permission-gated action.
- Agent access is limited to assigned properties/inquiries; agents cannot reassign
  themselves or request owner/private fields through property detail responses.

The details_json column extends the existing properties record rather than creating
competing inventory tables. The existing amenity relationship tables remain unused
by this incremental form and should be consolidated before expanding taxonomy APIs.

## Verification and migration operations

Requires Node 24 for node:sqlite and direct TypeScript test imports.

```bash
npm test
npx wrangler deploy --dry-run
```

21 unit/integration checks cover authorization, request origin, unit conversions,
input validation, verification requirements, Haversine distances, SQL bindings,
draft/public separation, editing, duplication, media upload, deduplication and
publication/privacy checks. Browser checks with fixture API responses passed at
320, 375, 390, 430, 768 and 1440px for form/template/nearby-place/media layouts.
These do not substitute for authenticated live-upload, penetration, load or
provider-integration testing.

A production export was saved under Git-ignored .wrangler before migration 0002.
Keep that backup private; it includes account/session records. Migration 0002 was
applied locally and then to production. Do not re-run an ALTER migration that has
already been applied. Existing setup scripts only apply migration 0001; new installs
must additionally run:

```bash
npx wrangler d1 execute bgv-admin --local --file=migrations/0002_property_details.sql
```

For a future production migration: export to private storage first, test against a
local copy, apply only unapplied migrations, verify row counts and access controls,
and deploy the corresponding Worker. Never restore over production without explicit
approval. No property records were deleted or imported during this upgrade.

## Remaining deliverables (not complete)

- Media core is implemented: private R2 originals, multiple JPEG/PNG uploads, progress,
  cancel/retry, SHA-256 deduplication per property, dimension/signature/size checks,
  image previews, captions/alt text/category, cover selection, reordering, publisher
  approval and soft removal. Public delivery checks publication, availability and
  approval on every request; URLs are not public-bucket paths. Migration 0003 adds
  metadata and cover/hash indexes. Tests use an in-memory R2 adapter; live upload
  still requires authenticated browser verification. Resizing, thumbnails, EXIF
  stripping, batch removal, replacement, restoration UI and responsive variants remain.
  Originals are retained privately on soft removal; no automatic purge is configured.
- Map picker/geocoding, provider lookup, structured location maintenance and enrichment
  conflict review. Select a provider and agree its credentials, costs and licensing.
- Published property detail/gallery storefront integration and dynamic search options.
- Consent/retention/deduplication/rate limiting for analytics, charts, reporting,
  date comparisons and CSV exports. No historical statistics exist.
- Full user lifecycle, password reset, optional MFA, role-aware navigation, review and
  publish screen, unsaved-change protection and comprehensive responsive testing.
- admin.bgventureproperties.ae was not verified reachable during the audit.

The deployed increment is not acceptance of the full platform specification.
