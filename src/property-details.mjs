export const SQFT_PER_SQM = 10.7639104167;
export function distanceMetres(a, b) {
  const valid = p => p && Number.isFinite(p.latitude) && Math.abs(p.latitude) <= 90 && Number.isFinite(p.longitude) && Math.abs(p.longitude) <= 180;
  if (!valid(a) || !valid(b)) throw new Error('Valid coordinates required');
  const rad = n => n * Math.PI / 180;
  const dlat = rad(b.latitude-a.latitude), dlon = rad(b.longitude-a.longitude);
  const h = Math.sin(dlat/2)**2 + Math.cos(rad(a.latitude))*Math.cos(rad(b.latitude))*Math.sin(dlon/2)**2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(h),Math.sqrt(Math.max(0,1-h)));
}
export function normalizeDetails(b) {
  for (const [key, min, max] of [['sale_price',0,1e15],['annual_rent',0,1e15],['monthly_rent',0,1e15],['deposit',0,1e15],['service_charges',0,1e15],['area_sqft',0,1e10],['area_sqm',0,1e10],['length_m',0,1e6],['width_m',0,1e6],['parking',0,100000],['latitude',-90,90],['longitude',-180,180]]) {
    if (!(key in b)) continue;
    if (b[key] === '' || b[key] === null) { b[key] = null; continue; }
    if (typeof b[key] !== 'number' || !Number.isFinite(b[key]) || b[key] < min || b[key] > max) throw new Error(`Invalid ${key}`);
  }
  if (b.area_sqft != null && b.area_sqm != null && Math.abs(b.area_sqft / SQFT_PER_SQM - b.area_sqm) > 0.01) throw new Error('Area measurements do not match');
  if (b.area_sqft != null) b.area_sqm = b.area_sqft / SQFT_PER_SQM;
  else if (b.area_sqm != null) b.area_sqft = b.area_sqm * SQFT_PER_SQM;
  if (b.map_url) {
    let u; try { u = new URL(b.map_url); } catch { throw new Error('Use a valid HTTPS Google Maps link'); }
    if (u.protocol !== 'https:' || !(['maps.google.com','maps.app.goo.gl','goo.gl'].includes(u.hostname) || (['www.google.com','google.com'].includes(u.hostname) && u.pathname.startsWith('/maps')))) throw new Error('Use a valid HTTPS Google Maps link');
  }
  for (const k of ['map_url','nearby_supermarkets','nearby_facilities','floor']) if (b[k] != null && (typeof b[k] !== 'string' || b[k].length > 2000)) throw new Error(`Invalid ${k}`);
  if (b.amenities != null && (!Array.isArray(b.amenities) || b.amenities.length > 50 || b.amenities.some(v => typeof v !== 'string' || v.length > 100))) throw new Error('Invalid amenities');
  if ('measurements' in b) {
    if (!Array.isArray(b.measurements) || b.measurements.length > 10) throw new Error('Invalid measurements');
    b.measurements = b.measurements.map(m => {
      if (!['built_up','plot','internal','balcony','other'].includes(m.kind) || !['sqft','sqm'].includes(m.unit) || !Number.isFinite(m.value) || m.value <= 0) throw new Error('Invalid measurement');
      return { kind:m.kind, unit:m.unit, value:m.value, sqft:m.unit==='sqft'?m.value:m.value*SQFT_PER_SQM, sqm:m.unit==='sqm'?m.value:m.value/SQFT_PER_SQM };
    });
    if (new Set(b.measurements.map(m=>m.kind)).size !== b.measurements.length) throw new Error('Duplicate measurement type');
  }
  if ('nearby_places' in b) {
    if (!Array.isArray(b.nearby_places) || b.nearby_places.length > 100) throw new Error('Invalid nearby places');
    b.nearby_places = b.nearby_places.map(p => {
      if (!p || typeof p.name !== 'string' || !p.name.trim() || p.name.length>200 || typeof p.category !== 'string' || p.category.length>100) throw new Error('Place name and category required');
      const verified = p.verified === true;
      if (verified && (typeof p.source !== 'string' || !p.source.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(p.verified_at || '') || !Number.isFinite(Date.parse(p.verified_at)) || p.verified_at > new Date().toISOString().slice(0,10))) throw new Error('Verified places need a source and valid verification date');
      const hasPoint = p.latitude != null || p.longitude != null;
      let distance = null;
      if (hasPoint) { distanceMetres(p,p); if (b.latitude != null && b.longitude != null) distance = distanceMetres(b,p); }
      return { name:p.name.trim(),category:p.category,source:String(p.source||'').slice(0,500),verified,verified_at:verified?p.verified_at:null,public:verified&&p.public===true,latitude:hasPoint?p.latitude:null,longitude:hasPoint?p.longitude:null,distance_metres:distance,distance_method:distance==null?null:'straight_line' };
    });
  }
  const keys = ['length_m','width_m','map_url','nearby_supermarkets','nearby_facilities','amenities','measurements','nearby_places'];
  return Object.fromEntries(keys.filter(k => k in b).map(k => [k,b[k]]));
}
