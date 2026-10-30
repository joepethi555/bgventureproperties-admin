-- BG Venture Properties Admin — initial schema (Cloudflare D1)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('super_admin','property_manager','listing_editor','agent','analytics_viewer')),
  status TEXT NOT NULL DEFAULT 'active',
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS properties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT UNIQUE NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  short_description TEXT,
  listing_type TEXT NOT NULL CHECK (listing_type IN ('sale','rent','off_plan')),
  category TEXT NOT NULL,
  property_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending','published','reserved','rented','sold','archived')),
  featured INTEGER NOT NULL DEFAULT 0,
  availability TEXT NOT NULL DEFAULT 'available',
  country TEXT NOT NULL DEFAULT 'United Arab Emirates',
  emirate TEXT NOT NULL DEFAULT 'Dubai',
  city TEXT, community TEXT, subcommunity TEXT, building TEXT, street TEXT,
  latitude REAL, longitude REAL,
  bedrooms TEXT, bathrooms TEXT,
  area_sqft REAL, area_sqm REAL, floor TEXT, furnishing TEXT, condition TEXT,
  parking INTEGER, balcony INTEGER DEFAULT 0, view_type TEXT, year_built TEXT, completion TEXT,
  currency TEXT NOT NULL DEFAULT 'AED',
  sale_price REAL, annual_rent REAL, monthly_rent REAL, deposit REAL, service_charges REAL, pricing_notes TEXT,
  developer TEXT, project_name TEXT, expected_completion TEXT, payment_plan TEXT,
  owner_name TEXT, owner_phone TEXT, owner_email TEXT,
  internal_ref TEXT, internal_notes TEXT, agreement_ref TEXT, follow_up_date TEXT,
  agent_id INTEGER REFERENCES users(id),
  seo_title TEXT, seo_description TEXT, main_image_alt TEXT, keywords TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_prop_status ON properties(status);
CREATE INDEX IF NOT EXISTS idx_prop_listing ON properties(listing_type);
CREATE INDEX IF NOT EXISTS idx_prop_category ON properties(category);
CREATE INDEX IF NOT EXISTS idx_prop_community ON properties(community);
CREATE INDEX IF NOT EXISTS idx_prop_price ON properties(sale_price, annual_rent);

CREATE TABLE IF NOT EXISTS property_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL, caption TEXT, alt_text TEXT,
  is_main INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'photo' CHECK (kind IN ('photo','floorplan','brochure')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS amenities (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS property_amenities (
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  amenity_id INTEGER NOT NULL REFERENCES amenities(id) ON DELETE CASCADE,
  PRIMARY KEY (property_id, amenity_id)
);

CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER REFERENCES locations(id),
  kind TEXT NOT NULL CHECK (kind IN ('emirate','city','community','subcommunity','building')),
  name TEXT NOT NULL, UNIQUE (parent_id, kind, name)
);

CREATE TABLE IF NOT EXISTS inquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT UNIQUE NOT NULL,
  property_id INTEGER REFERENCES properties(id) ON DELETE SET NULL,
  name TEXT, email TEXT, phone TEXT, message TEXT,
  source TEXT NOT NULL DEFAULT 'contact_form',
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','follow_up','qualified','closed','spam')),
  assigned_agent INTEGER REFERENCES users(id),
  preferred_contact TEXT, follow_up_date TEXT, internal_notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS analytics_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  property_id INTEGER,
  session_id TEXT,
  page TEXT, referrer TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT,
  device TEXT, country TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_name_time ON analytics_events(event, created_at);
CREATE INDEX IF NOT EXISTS idx_events_property ON analytics_events(property_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_session ON analytics_events(session_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL, entity TEXT, entity_id TEXT, detail TEXT,
  ip TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

-- Default amenity options (admin can manage later)
INSERT OR IGNORE INTO amenities (name) VALUES
 ('Swimming Pool'),('Gym'),('Covered Parking'),('Balcony'),('Built-In Wardrobes'),
 ('Central Air Conditioning'),('Security'),('Concierge'),("Children's Play Area"),
 ('Garden'),('Private Garden'),('Private Pool'),('Sea View'),('City View'),
 ('Community View'),('Furnished'),('Kitchen Appliances'),('Public Transport Access'),
 ('Nearby Schools'),('Nearby Shopping'),('Nearby Healthcare');
