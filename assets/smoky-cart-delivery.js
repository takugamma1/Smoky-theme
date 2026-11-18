/**
 * Smoky ordering flow: "Доставка или вземане?" → address → menu → cart → checkout.
 *
 *   <smoky-order-type>     snippets/smoky-order-type.liquid — the bubble asked on the menu (and
 *                          reopened from the chip / the cart). Delivery continues to the address
 *                          step; the address must be PICKED from the lookup or come from "use my
 *                          location", so typed text alone is never accepted.
 *   <smoky-cart-delivery>  snippets/smoky-cart-delivery.liquid — the choice in the cart + the note.
 *   <smoky-cart-progress>  snippets/smoky-cart-progress.liquid — minimum-order bar; the checkout
 *                          button stays locked until the zone's minimum is reached.
 *
 * Zones (fee + minimum order) are Shopify's own Local delivery zones. For a picked address the
 * script ASKS SHOPIFY which zone applies (Storefront API, a throwaway cart big enough to clear
 * every minimum), so the cart can never promise something checkout will refuse — and MEASURES
 * the distance itself from the point the lookup returned (theme settings: same zone table).
 * Shopify geocodes the typed text on its own and answers for the city centre when it does not
 * know the street, so an address counts as deliverable only when both agree.
 *
 * The choice is saved on the cart (attributes „Получаване“, „Адрес за доставка“, „Координати“,
 * „Пощенски код“ + the note) and handed to checkout through the Storefront API (delivery
 * address / pickup preference), so checkout opens with it already filled in.
 *
 * Opening hours (theme settings, Bulgarian time): outside them nothing can be ordered — the
 * bubble says when orders are taken and the checkout button is locked; after the last delivery
 * time only pickup is left until closing. The clock is the server's (Date header of /cart.js)
 * when the device's own differs from it.
 *
 * Lookup: Google Maps (Places + Geocoding) when the theme has an API key, otherwise
 * OpenStreetMap (Photon / Nominatim) — same UI, less precise house numbers. The OpenStreetMap
 * path reads the address the way people write it (parseAddressQuery): „ул./бул./кв./ж.к.“,
 * quotes, district, city and postcode are understood, not required; „бл.“ is a house number,
 * „вх./ет./ап.“ are kept as the second address line. A street that is known without that
 * house number is still offered with the number the customer typed (approximate point).
 */

const LS_KEY = 'smoky_order_v2';
const SS_ASKED = 'smoky_order_asked';
const SS_CLOSED = 'smoky_order_closed_seen';
const SHOP_TIMEZONE = 'Europe/Sofia';
const ATTR = { mode: 'Получаване', address: 'Адрес за доставка', coords: 'Координати', zip: 'Пощенски код', phone: 'Телефон' };
// order attribute values the kitchen / bridge read (same wording as the other restaurants' shops)
const MODE_VALUE = { delivery: 'Доставка', pickup: 'Вземане от място' };
const STOREFRONT_API = '/api/2026-10/graphql.json';

// Lookups are limited to Varna and its surroundings, and always answered in Bulgarian,
// whatever the site language — the kitchen and the courier read the address.
const CENTER = { lat: 43.2141, lng: 27.9147 };
const AREA = { west: 27.6, south: 43.05, east: 28.2, north: 43.45 };
const DEFAULT_CITY = 'Варна';
// Checkout will not show delivery options without a postcode, and nobody knows theirs by heart:
// when the lookup has none for the address, Varna's general one goes in.
const DEFAULT_ZIP = '9000';
const LOOKUP_LANG = 'bg';

const inArea = (lat, lng) => lat >= AREA.south && lat <= AREA.north && lng >= AREA.west && lng <= AREA.east;
const round6 = (n) => +Number(n).toFixed(6);
const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

/** 1099 → "€10,99" (the shop's own money format). */
export const money = (cents) => `€${(Math.round(cents) / 100).toFixed(2).replace('.', ',')}`;

/* ── configuration (rendered on <smoky-order-type>) ───── */

/** "2 | 10.99 | 2.59; 4 | 12.99 | 3.49" → [{ radius: 2, min: 1099, fee: 259 }, …] sorted by radius. */
export function parseZones(text) {
  return String(text || '')
    .split(/[;\n]/)
    .map((line) => line.split('|').map((part) => parseFloat(part.trim().replace(',', '.'))))
    .filter((parts) => parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite))
    .map(([radius, min, fee]) => ({ radius, min: Math.round(min * 100), fee: Math.round(fee * 100) }))
    .sort((a, b) => a.radius - b.radius);
}

/** "09:00" → 540 (minutes after midnight); null when it is not a time. */
export function parseTime(text) {
  const match = /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(String(text || ''));
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours <= 24 && minutes < 60 ? hours * 60 + minutes : null;
}

/** Minutes after midnight at the restaurant for a moment in time (epoch ms). */
export function shopMinutes(epochMs, timeZone = SHOP_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(epochMs));
  const part = (type) => Number(parts.find((p) => p.type === type)?.value || 0);
  return part('hour') * 60 + part('minute');
}

/**
 * hours = { open, close, lastDelivery } in minutes after midnight (no open/close = always open).
 * → { open, delivery }: are orders taken at all, and are delivery orders taken.
 * The closing minute is already closed; the last delivery minute still counts ("20:40 is the
 * last moment to order").
 */
export function hoursStatus(minutes, hours) {
  const { open, close, lastDelivery } = hours || {};
  if (open == null || close == null) return { open: true, delivery: true };
  const isOpen = open < close ? minutes >= open && minutes < close : minutes >= open || minutes < close;
  return { open: isOpen, delivery: isOpen && (lastDelivery == null || minutes <= lastDelivery) };
}

let cachedConfig = null;
function config() {
  if (cachedConfig) return cachedConfig;
  const el = document.querySelector('smoky-order-type');
  const d = el?.dataset || {};
  let strings = {};
  try {
    strings = JSON.parse(el?.querySelector('[data-ot-strings]')?.textContent || '{}');
  } catch (_) {
    strings = {};
  }
  const result = {
    zones: parseZones(d.zones),
    store: { lat: parseFloat(d.storeLat), lng: parseFloat(d.storeLng), address: d.storeAddress || '' },
    pickup: d.pickup !== 'false',
    hours: { open: parseTime(d.open), close: parseTime(d.close), lastDelivery: parseTime(d.lastDelivery) },
    mapsKey: d.mapsKey || '',
    probeVariant: d.probeVariant || '',
    probePrice: Number(d.probePrice || 0),
    strings,
  };
  if (el) cachedConfig = result;
  return result;
}

const t = (key) => config().strings[key] || '';

/* ── the clock ───────────────────────────────────────── */

let clockOffset = 0; // server time − device time, when the device clock is off
const now = () => Date.now() + clockOffset;
const openNow = () => hoursStatus(shopMinutes(now()), config().hours);
const showTime = (minutes) => `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
/** "от [open] до [close]" with the hours from the settings. */
const withHours = (text) => {
  const { open, close, lastDelivery } = config().hours;
  return String(text || '')
    .replace('[open]', showTime(open ?? 0))
    .replace('[close]', showTime(close ?? 0))
    .replace('[last]', showTime(lastDelivery ?? close ?? 0));
};
const announce = () => document.dispatchEvent(new CustomEvent('smoky:order', { detail: state }));

/** A device clock that is right to the minute is left alone; a real difference is corrected. */
async function syncClock() {
  try {
    const started = Date.now();
    const response = await fetch(`${window.Shopify?.routes?.root || '/'}cart.js`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    const server = Date.parse(response.headers.get('Date') || '');
    if (!Number.isFinite(server)) return;
    const offset = server - (started + Date.now()) / 2;
    if (Math.abs(offset) > 90000) {
      clockOffset = offset;
      announce();
    }
  } catch (_) {
    /* the device clock it is */
  }
}

/* ── state ───────────────────────────────────────────── */

/**
 * mode:    'delivery' | 'pickup' | null
 * address: { line1, street, city, zip, lat, lng, label, precise, approx } | null
 * zone:    { min, fee } (cents) | { out: true } | null
 */
function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (saved && typeof saved === 'object') return { mode: saved.mode || null, address: saved.address || null, zone: saved.zone || null };
  } catch (_) {
    /* private mode / blocked storage */
  }
  return { mode: null, address: null, zone: null };
}

const state = loadState();
let cartSyncTimer = null;

function commit(patch) {
  Object.assign(state, patch);
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch (_) {
    /* the cart still gets it */
  }
  clearTimeout(cartSyncTimer);
  cartSyncTimer = setTimeout(() => cartUpdate({ attributes: cartAttributes() }).catch(() => {}), 300);
  announce();
}

function cartAttributes() {
  const address = state.mode === 'delivery' ? state.address : null;
  return {
    [ATTR.mode]: state.mode ? MODE_VALUE[state.mode] : '',
    [ATTR.address]: address ? address.label : '',
    // an approximate point (street matched, house number typed) is not sent as the drop-off pin
    [ATTR.coords]: address && address.lat != null && !address.approx ? `${address.lat},${address.lng}` : '',
    [ATTR.zip]: address ? address.zip || DEFAULT_ZIP : '',
    [ATTR.phone]: '', // the phone is collected at checkout now
  };
}

/** Can this cart go to checkout? `reason`: closed | choose | delivery-closed | address | range | min. */
export function orderStatus(current, totalCents, hours = { open: true, delivery: true }) {
  if (!hours.open) return { ok: false, reason: 'closed' };
  if (!current.mode) return { ok: false, reason: 'choose' };
  if (current.mode === 'pickup') return { ok: true };
  if (!hours.delivery) return { ok: false, reason: 'delivery-closed' };
  if (!current.address) return { ok: false, reason: 'address' };
  if (!current.zone || current.zone.out) return { ok: false, reason: 'range' };
  if (totalCents < current.zone.min) return { ok: false, reason: 'min', missing: current.zone.min - totalCents };
  return { ok: true };
}

/* ── cart + Storefront API ───────────────────────────── */

async function cartUpdate(body) {
  const response = await fetch(window.Theme?.routes?.cart_update_url || '/cart/update.js', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error('cart_update_failed');
  return response.json();
}

async function storefront(query, variables) {
  const response = await fetch(STOREFRONT_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error('storefront_failed');
  const json = await response.json();
  if (json.errors?.length) throw new Error('storefront_errors');
  return json.data;
}

const deliveryAddressInput = (address) => ({
  selected: true,
  oneTimeUse: true,
  address: {
    deliveryAddress: {
      address1: address.line1,
      ...(address.extra ? { address2: address.extra } : {}),
      city: address.city || DEFAULT_CITY,
      zip: address.zip || DEFAULT_ZIP,
      countryCode: 'BG',
    },
  },
});

/** Zone table entry for a fee Shopify quoted (cents); unknown fees still get a sensible minimum. */
export function zoneForFee(zones, fee) {
  const match = zones.find((zone) => Math.abs(zone.fee - fee) <= 1);
  if (match) return { min: match.min, fee: match.fee };
  const next = zones.find((zone) => zone.fee >= fee) || zones[zones.length - 1];
  return { min: next ? next.min : 0, fee };
}

const toRad = (deg) => (deg * Math.PI) / 180;

/** Straight-line distance in km — how Shopify measures a local delivery radius. */
export function distanceKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export function zoneForDistance(zones, km) {
  const match = zones.find((zone) => km <= zone.radius);
  return match ? { min: match.min, fee: match.fee } : { out: true };
}

/**
 * Ask Shopify which local-delivery fee applies to this address: a throwaway cart, big enough to
 * clear every zone's minimum, with the address on it. Resolves the fee in cents, or null when
 * Shopify offers no local delivery there. Throws when the question could not be asked.
 */
async function probeFee(address) {
  const { zones, probeVariant, probePrice } = config();
  if (!probeVariant || !(probePrice > 0)) throw new Error('no_probe_product');
  const highest = Math.max(0, ...zones.map((zone) => zone.min));
  const quantity = Math.min(200, Math.max(1, Math.ceil((highest + 100) / probePrice)));
  const data = await storefront(
    `mutation SmokyZone($input: CartInput!) {
      cartCreate(input: $input) {
        cart { deliveryGroups(first: 5) { nodes { deliveryOptions { deliveryMethodType estimatedCost { amount } } } } }
        userErrors { code message }
      }
    }`,
    {
      input: {
        lines: [{ merchandiseId: `gid://shopify/ProductVariant/${probeVariant}`, quantity }],
        buyerIdentity: { countryCode: 'BG' },
        delivery: { addresses: [deliveryAddressInput(address)] },
      },
    }
  );
  const cart = data?.cartCreate?.cart;
  if (!cart) throw new Error('probe_failed');
  const local = (cart.deliveryGroups?.nodes || [])
    .flatMap((group) => group.deliveryOptions || [])
    .filter((option) => option.deliveryMethodType === 'LOCAL')
    .map((option) => Math.round(parseFloat(option.estimatedCost.amount) * 100));
  return local.length ? Math.min(...local) : null;
}

/** How far past the last radius our own measurement still gives Shopify the benefit of the doubt (km). */
const RANGE_TOLERANCE_KM = 0.3;

/**
 * Shopify's zone and our measured zone → the one the order is held to.
 * Out of range if either says so; otherwise the fee is Shopify's (that is what checkout will
 * charge) and the minimum is the stricter of the two.
 */
export function settleZone(quoted, measured) {
  if (!measured) return quoted;
  if (!quoted) return measured;
  if (quoted.out || measured.out) return { out: true };
  return { fee: quoted.fee, min: Math.max(quoted.min, measured.min) };
}

/** { min, fee } for the address, or { out: true } when it is outside every zone. */
async function resolveZone(address) {
  const { zones, store } = config();
  let measured = null;
  if (address.lat != null && Number.isFinite(store.lat) && Number.isFinite(store.lng) && zones.length) {
    const km = distanceKm(store, address);
    const last = zones[zones.length - 1];
    measured = km > last.radius + RANGE_TOLERANCE_KM ? { out: true } : zoneForDistance(zones, Math.min(km, last.radius));
  }
  if (measured?.out) return measured; // no need to ask
  let quoted = null;
  try {
    // Local delivery is the only way to ship, so "no option" = Shopify will not deliver there.
    // Asked twice before it is believed: a single empty answer can be a hiccup.
    let fee = await withTimeout(probeFee(address), 7000);
    if (fee == null) fee = await withTimeout(probeFee(address), 7000);
    quoted = fee == null ? { out: true } : zoneForFee(zones, fee);
  } catch (error) {
    if (!measured) throw error;
  }
  return settleZone(quoted, measured);
}

/** Put the choice on the cart itself, which is what makes checkout open with it filled in. */
async function prefillCheckout(cartToken) {
  if (!cartToken) return;
  const id = `gid://shopify/Cart/${cartToken}`;
  if (state.mode === 'delivery' && state.address) {
    await storefront(
      `mutation SmokyDelivery($id: ID!, $addresses: [CartSelectableAddressInput!]!, $buyer: CartBuyerIdentityInput!) {
        cartDeliveryAddressesReplace(cartId: $id, addresses: $addresses) { userErrors { code message } }
        cartBuyerIdentityUpdate(cartId: $id, buyerIdentity: $buyer) { userErrors { code message } }
      }`,
      { id, addresses: [deliveryAddressInput(state.address)], buyer: { countryCode: 'BG', preferences: { delivery: { deliveryMethod: ['SHIPPING'] } } } }
    );
  } else if (state.mode === 'pickup') {
    await storefront(
      `mutation SmokyPickup($id: ID!, $buyer: CartBuyerIdentityInput!) {
        cartBuyerIdentityUpdate(cartId: $id, buyerIdentity: $buyer) { userErrors { code message } }
      }`,
      { id, buyer: { countryCode: 'BG', preferences: { delivery: { deliveryMethod: ['PICK_UP'] } } } }
    );
  }
}

/* ── address lookups ─────────────────────────────────── */

async function fetchJson(url, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error('lookup_failed');
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Google Maps ──
let googleMaps = null; // Promise<google.maps>
let googleBroken = false; // bad key, quota, blocked script → OpenStreetMap takes over
let googleSession = null; // autocomplete session token (one per search → pick)

function loadGoogle(key) {
  if (!googleMaps) {
    googleMaps = new Promise((resolve, reject) => {
      const callback = `__smokyMapsReady${Date.now()}`;
      window[callback] = () => {
        delete window[callback];
        resolve(window.google.maps);
      };
      // Google calls this when the key is refused (wrong key, referrer not allowed, API off)
      window.gm_authFailure = () => {
        googleBroken = true;
        reject(new Error('maps_auth_failed'));
      };
      const script = document.createElement('script');
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&language=${LOOKUP_LANG}&region=BG&callback=${callback}`;
      script.async = true;
      script.onerror = () => reject(new Error('maps_load_failed'));
      document.head.appendChild(script);
    });
    googleMaps.catch(() => {
      googleBroken = true;
    });
  }
  return googleMaps;
}

const useGoogle = () => Boolean(config().mapsKey) && !googleBroken;
const GOOGLE_PRECISE_TYPES = ['street_address', 'premise', 'subpremise', 'establishment', 'point_of_interest'];

/** One shape for a Places `Place` (longText) and a Geocoder result (long_name). */
function fromGoogle({ components, formatted, location, types }) {
  const get = (type) => {
    const c = (components || []).find((x) => (x.types || []).includes(type));
    return c ? c.longText || c.long_name || '' : '';
  };
  const lat = typeof location?.lat === 'function' ? location.lat() : location?.lat;
  const lng = typeof location?.lng === 'function' ? location.lng() : location?.lng;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  // exactly Google's own wording, minus the country
  const label = String(formatted || '').replace(/,\s*(България|Bulgaria|Bulgarien)\s*$/i, '').trim();
  const street = get('route');
  const line1 = label.split(',')[0].trim() || [street, get('street_number')].filter(Boolean).join(' ');
  if (!line1) return null;
  return {
    line1,
    street: street || line1,
    city: get('locality') || get('postal_town') || get('administrative_area_level_3') || DEFAULT_CITY,
    zip: get('postal_code'),
    lat: round6(lat),
    lng: round6(lng),
    label: label || line1,
    precise: Boolean(get('street_number') || get('premise') || get('subpremise')) || (types || []).some((type) => GOOGLE_PRECISE_TYPES.includes(type)),
  };
}

async function googleSearch(query) {
  const maps = await loadGoogle(config().mapsKey);
  const { AutocompleteSuggestion, AutocompleteSessionToken } = await maps.importLibrary('places');
  if (!googleSession) googleSession = new AutocompleteSessionToken();
  const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions({
    input: query,
    sessionToken: googleSession,
    language: LOOKUP_LANG,
    region: 'bg',
    includedRegionCodes: ['bg'],
    locationRestriction: AREA,
    origin: CENTER,
  });
  return (suggestions || [])
    .map((s) => s.placePrediction)
    .filter(Boolean)
    .slice(0, 6)
    .map((prediction) => ({
      title: prediction.mainText?.text || prediction.text?.text || '',
      subtitle: prediction.secondaryText?.text || '',
      resolve: async () => {
        const place = prediction.toPlace();
        await place.fetchFields({ fields: ['addressComponents', 'formattedAddress', 'location', 'types'] });
        googleSession = null; // the session ends with the details request
        return fromGoogle({ components: place.addressComponents, formatted: place.formattedAddress, location: place.location, types: place.types });
      },
    }));
}

async function googleReverse(lat, lng) {
  const maps = await loadGoogle(config().mapsKey);
  const { Geocoder } = await maps.importLibrary('geocoding');
  const { results } = await new Geocoder().geocode({ location: { lat, lng }, language: LOOKUP_LANG, region: 'bg' });
  const addresses = (results || [])
    .map((r) => fromGoogle({ components: r.address_components, formatted: r.formatted_address, location: r.geometry?.location, types: r.types }))
    .filter(Boolean);
  return addresses.find((a) => a.precise) || null;
}

// ── OpenStreetMap (no key) ──
const PHOTON_URL = 'https://photon.komoot.io';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org';

// OpenStreetMap postcodes are patchy; only trust ones from the Varna region (9xxx).
const cleanZip = (zip) => (/^9\d{3}$/.test(String(zip || '')) ? String(zip) : '');

function osmAddress({ street, housenumber, district, city, zip, lat, lng }) {
  if (!street || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const line1 = [street, housenumber].filter(Boolean).join(' ');
  const town = city || DEFAULT_CITY;
  return {
    line1,
    street,
    district: district && district !== street ? district : '',
    city: town,
    zip: cleanZip(zip),
    lat: round6(lat),
    lng: round6(lng),
    label: [line1, district && district !== street ? district : '', [cleanZip(zip), town].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    precise: Boolean(housenumber),
  };
}

function fromPhoton(feature) {
  const p = feature?.properties || {};
  const [lng, lat] = feature?.geometry?.coordinates || [];
  return osmAddress({
    street: p.street || (p.type === 'street' ? p.name : '') || '',
    housenumber: p.housenumber || '',
    district: p.district || '',
    city: p.city || p.town || p.village || '',
    zip: p.postcode,
    lat,
    lng,
  });
}

/* What people actually type: „ЛевскиПриморски, ул. „Мир“ 33, 9010 Варна“ (copied from a map),
   „ж.к. Чайка бл. 28 вх. Б ет. 5 ап. 60“, „Мир 33“. The lookup wants bare words. */
const lower = (text) => String(text || '').toLowerCase();
const STREET_MARK = /(?:^|[\s,])(?:улица|ул|булевард|бул|площад|пл)(?:\.\s*|\s+)/i;
const AREA_MARK = /(?:^|[\s,])(?:квартал|кв|ж\.\s?к|жк|район|р-н|местност|м-т)(?:\.\s*|\s+)/gi;
const BLOCK = /(?:^|[\s,])бл(?:ок)?\.?\s*(\d+\s?[А-Яа-яA-Za-z]?)(?=$|[\s,.])/i;
const EXTRA = /(?:^|[\s,])(вх(?:од)?|ет(?:аж)?|ап(?:артамент)?)\.?\s*(\d+\s?[А-Яа-яA-Za-z]?|[А-Яа-яA-Za-z])(?=$|[\s,.])/gi;
const HOUSE_NUMBER = /\s(\d+\s?[А-Яа-яA-Za-z]?)\s*$/;
const ONLY_NUMBER = /^\s*\d+\s?[А-Яа-яA-Za-z]?\s*$/;

/**
 * "ЛевскиПриморски, ул. „Мир“ 33" → { street: 'Мир', area: 'Левски Приморски', number: '33',
 * block: false, extras: [], latin: false }. `extras` are entrance / floor / flat ("вх. Б").
 */
export function parseAddressQuery(raw) {
  let text = String(raw || '')
    .replace(/[„“”"«»‘’'`]/g, ' ')
    .replace(/№/g, ' ')
    .replace(/([а-яa-z])([А-ЯA-Z])/g, '$1 $2') // "ЛевскиПриморски" → "Левски Приморски"
    .replace(/\s+/g, ' ')
    .trim();

  const extras = [];
  text = text.replace(EXTRA, (_, kind, value) => {
    extras.push(`${lower(kind).slice(0, 2)}. ${value.replace(/\s+/g, '').toUpperCase()}`);
    return ' ';
  });

  let number = '';
  let block = false;
  text = text.replace(BLOCK, (_, value) => {
    number = value;
    block = true;
    return ' ';
  });

  // city, country and postcode tell the lookup nothing it does not already know
  text = text
    .replace(/(?:^|[\s,])9\d{3}(?=$|[\s,])/g, ' ')
    .replace(/(?:^|[\s,])(?:гр\.?\s*)?(?:варна|varna)(?=$|[\s,])/gi, ' ')
    .replace(/(?:^|[\s,])(?:българия|bulgaria)(?=$|[\s,])/gi, ' ');

  let street = text;
  let area = '';
  const mark = STREET_MARK.exec(text);
  if (mark) {
    // "ул." says where the street starts: what stands before it is the district
    area = text.slice(0, mark.index);
    const pieces = text.slice(mark.index + mark[0].length).split(',');
    street = pieces.shift() || '';
    for (const piece of pieces) {
      if (!number && !/\d/.test(street) && ONLY_NUMBER.test(piece)) street += ` ${piece.trim()}`;
      else area += ` ${piece}`;
    }
  } else if (text.includes(',')) {
    // no "ул.": the piece that carries the number is the street, the rest is the district
    const pieces = text.split(',').map((piece) => piece.trim()).filter(Boolean);
    const index = number ? -1 : pieces.findIndex((piece) => /\d/.test(piece));
    if (index >= 0) {
      street = pieces[index];
      area = pieces.filter((_, i) => i !== index).join(' ');
    } else {
      street = pieces.join(' ');
    }
  }

  const tidy = (part) => ` ${part}`.replace(AREA_MARK, ' ').replace(/[,.]/g, ' ').replace(/\s+/g, ' ').trim();
  street = tidy(street);
  area = tidy(area);
  if (!number) {
    const match = HOUSE_NUMBER.exec(street); // the last number is the house; "8-ми Приморски полк 128"
    if (match) {
      number = match[1];
      street = street.slice(0, match.index).trim();
    }
  }
  return { street, area, number: number.replace(/\s+/g, '').toUpperCase(), block, extras, latin: /[a-z]/i.test(street) && !/[а-я]/i.test(street) };
}

const SKIP_WORDS = new Set(['ул', 'улица', 'бул', 'булевард', 'пл', 'площад', 'кв', 'жк', 'ж', 'к']);
const words = (text) =>
  lower(text)
    .replace(/["„“”«».,()]/g, ' ')
    .split(/[\s-]+/)
    .filter((word) => word && !SKIP_WORDS.has(word));
const numberKey = (text) => lower(text).replace(/бл(?:ок)?\.?/, '').replace(/[^0-9a-zа-я]/g, '');

/**
 * Photon features → the rows offered for a typed address, best first:
 * the exact house · the street with the typed number (approximate point) · houses whose number
 * starts the same · the bare street · places by name. Features that only share the number or
 * a generic word with the query ("ул." → ул. „13-та“) are dropped.
 */
export function addressRows(features, parsed) {
  const typed = words(parsed.street);
  const areaWords = words(parsed.area);
  const wanted = numberKey(parsed.number);
  const shown = parsed.number ? (parsed.block ? `бл. ${parsed.number}` : parsed.number) : '';
  const rows = [];
  const seen = new Set();
  const exactStreets = new Set();
  let spare = null; // a house on the right street whose number starts like the typed one

  (features || []).forEach((feature, order) => {
    const p = feature?.properties || {};
    const address = fromPhoton(feature);
    if (!address) return;
    const streetWords = words(address.street);
    const placeWords = words(`${p.district || ''} ${p.locality || ''} ${p.city || ''}`);
    const nameWords = p.type === 'street' ? [] : words(p.name);
    const starts = (pool) => (word) => pool.some((candidate) => candidate.startsWith(word));
    const byStreet = parsed.latin || !typed.length || (typed.some(starts(streetWords)) && typed.every(starts([...streetWords, ...placeWords])));
    const byName = !byStreet && !wanted && nameWords.length > 0 && typed.some(starts(nameWords)) && typed.every(starts([...nameWords, ...placeWords]));
    if (!byStreet && !byName) return;

    const near = areaWords.length > 0 && areaWords.some(starts(placeWords)) ? 0 : 1;
    const add = (rank, key, row) => {
      if (seen.has(key)) return;
      seen.add(key);
      rows.push({ rank, near, order, streetKey: lower(address.street), ...row });
    };
    const rest = (a) => a.label.split(', ').slice(1).join(', ');

    if (byName) {
      if (address.precise) add(6, `name|${p.name}|${address.label}`, { title: p.name, subtitle: address.label, address });
      return;
    }
    if (address.precise) {
      const key = numberKey(p.housenumber);
      if (wanted && key !== wanted) {
        if (!key.startsWith(wanted)) return; // another building on the street
        if (!spare) spare = address;
        return void add(3, address.label, { title: address.line1, subtitle: rest(address), address });
      }
      if (wanted) exactStreets.add(lower(address.street));
      return void add(wanted ? 0 : 2, address.label, { title: address.line1, subtitle: rest(address), address });
    }
    if (wanted) {
      // the street is known, this house number is not: keep the customer's number, the point is the street's
      const guess = typedNumberOn(address, shown);
      return void add(1, `street|${lower(address.street)}|${lower(address.district)}`, { title: guess.line1, subtitle: rest(guess), address: guess });
    }
    add(5, `street|${lower(address.street)}|${lower(address.district)}`, { title: address.line1, subtitle: rest(address), address });
  });

  let out = rows.filter((row) => !(row.rank === 1 && exactStreets.has(row.streetKey)));
  if (wanted && spare && !out.some((row) => row.rank <= 1)) {
    const guess = typedNumberOn(spare, shown);
    out.push({ rank: 1, near: 0, order: -1, title: guess.line1, subtitle: guess.label.split(', ').slice(1).join(', '), address: guess });
  }
  return out
    .sort((a, b) => a.rank - b.rank || a.near - b.near || a.order - b.order)
    .slice(0, 6)
    .map(({ title, subtitle, address }) => ({ title, subtitle, resolve: async () => address }));
}

/** The street of `address` with the house number the customer typed; the point stays approximate. */
function typedNumberOn(address, number) {
  const line1 = `${address.street} ${number}`;
  return {
    ...address,
    line1,
    label: [line1, address.district, [address.zip, address.city].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    approx: true,
    precise: true,
  };
}

async function photonFeatures(query) {
  const params = new URLSearchParams({
    q: query,
    limit: '10',
    lang: 'default', // local (Bulgarian) names regardless of the browser language
    lat: String(CENTER.lat),
    lon: String(CENTER.lng),
    bbox: `${AREA.west},${AREA.south},${AREA.east},${AREA.north}`,
  });
  ['house', 'street'].forEach((layer) => params.append('layer', layer));
  const data = await fetchJson(`${PHOTON_URL}/api/?${params}`);
  return data?.features || [];
}

/** Several spellings of the same question, most telling first; the first that finds something wins. */
export async function osmSearch(query, isStale = () => false) {
  const parsed = parseAddressQuery(query);
  if (!parsed.street) return [];
  const { street, area, number } = parsed;
  const spellings = [
    [street, number, DEFAULT_CITY], // "Мир 33" alone finds nothing, "Мир 33 Варна" does
    [street, number],
    area ? [area, street, number] : null,
    number ? [street, DEFAULT_CITY] : null,
  ]
    .filter(Boolean)
    .map((parts) => parts.filter(Boolean).join(' '));
  for (const spelling of new Set(spellings)) {
    const rows = addressRows(await photonFeatures(spelling), parsed);
    if (rows.length || isStale()) return rows;
  }
  return [];
}

async function osmReverse(lat, lng) {
  try {
    const data = await fetchJson(`${PHOTON_URL}/reverse?lat=${lat}&lon=${lng}&lang=default`);
    const address = fromPhoton(data?.features?.[0]);
    if (address?.precise) return address;
  } catch (_) {
    /* fall through to Nominatim */
  }
  const data = await fetchJson(`${NOMINATIM_URL}/reverse?format=jsonv2&addressdetails=1&zoom=18&accept-language=${LOOKUP_LANG}&lat=${lat}&lon=${lng}`);
  const a = data?.address || {};
  const address = osmAddress({
    street: a.road || a.pedestrian || a.residential || '',
    housenumber: a.house_number || '',
    district: a.suburb || a.neighbourhood || '',
    city: a.city || a.town || a.village || '',
    zip: a.postcode,
    lat: Number(data?.lat),
    lng: Number(data?.lon),
  });
  return address?.precise ? address : null;
}

/* ── the bubble ──────────────────────────────────────── */

const cartDrawer = () => document.querySelector('theme-drawer#cart-drawer');

/** A known address as a row of the list: the one already on the order, or the one "locate" found. */
function addressRow(address) {
  const rest =
    address.label && address.label.startsWith(address.line1)
      ? address.label.slice(address.line1.length).replace(/^[,\s]+/, '')
      : address.city || '';
  return { title: address.line1, subtitle: rest, resolve: async () => address };
}

class SmokyOrderType extends HTMLElement {
  connectedCallback() {
    if (this.ready) return;
    this.ready = true;

    this.$ = (selector) => this.querySelector(selector);
    this.dialog = this.$('dialog');
    this.input = this.$('[data-ot-address]');
    this.list = this.$('[data-ot-suggestions]');
    this.locateButton = this.$('[data-ot-locate]');
    this.result = this.$('[data-ot-result]');
    this.chip = this.$('[data-ot-chip]');

    this.suggestions = [];
    this.active = -1;
    this.searchSeq = 0;
    this.checkSeq = 0; // a zone answer only counts if nothing happened in the bubble meanwhile
    this.reopenDrawer = false;

    this.bind();
    this.renderChip();
    document.addEventListener('smoky:order', () => this.renderChip());

    // the cart may have lost the choice (new cart, other tab): put it back
    if (state.mode && (this.dataset.cartMode || '') !== MODE_VALUE[state.mode]) commit({});

    const seen = (key) => {
      try {
        return Boolean(sessionStorage.getItem(key));
      } catch (_) {
        return false;
      }
    };
    // closed: say when orders are taken (once per visit); open: ask the question (once per visit)
    const shouldOpen = openNow().open ? !state.mode && !seen(SS_ASKED) : !seen(SS_CLOSED);
    if (this.dataset.auto === 'true' && shouldOpen) setTimeout(() => this.open('choose'), 900);

    syncClock();
    setInterval(announce, 30000); // opening, last delivery and closing arrive while the page is open
  }

  bind() {
    this.addEventListener('click', (event) => {
      const mode = event.target.closest('[data-ot-mode]');
      if (mode) return void this.choose(mode.dataset.otMode);
      if (event.target.closest('[data-ot-back]')) return void this.show('choose');
      if (event.target.closest('[data-ot-close]')) return void this.close();
      if (event.target.closest('[data-ot-locate]')) return void this.locate();
      const row = event.target.closest('[data-index]');
      if (row) return void this.pick(this.suggestions[Number(row.dataset.index)]);
      if (event.target === this.dialog) this.close(); // the dimmed area around the bubble
    });
    this.dialog.addEventListener('close', () => this.onClosed());
    this.input.addEventListener('input', () => this.onInput());
    this.input.addEventListener('keydown', (event) => this.onKey(event));
  }

  /* ── open / close / steps ── */

  open(step = 'choose') {
    const drawer = cartDrawer();
    // The cart's own "tapped outside?" handlers would swallow taps on the bubble: close it
    // first and bring it back once the choice is made.
    this.reopenDrawer = Boolean(drawer?.querySelector('dialog')?.open);
    if (this.reopenDrawer) drawer.close?.();
    this.show(openNow().open ? step : 'closed');
    if (!this.dialog.open) this.dialog.showModal();
  }

  close() {
    if (this.dialog.open) this.dialog.close();
  }

  onClosed() {
    this.checkSeq++; // closed while an address was being checked: that answer is dropped
    try {
      // once per visit each; the chip and the cart keep offering the question
      sessionStorage.setItem(this.shownClosed ? SS_CLOSED : SS_ASKED, '1');
    } catch (_) {
      /* ignore */
    }
    if (this.reopenDrawer) {
      this.reopenDrawer = false;
      cartDrawer()?.open?.();
    }
  }

  show(step) {
    this.querySelectorAll('[data-ot-step]').forEach((el) => {
      el.hidden = el.dataset.otStep !== step;
    });
    this.querySelectorAll('[data-ot-step="choose"] [data-ot-mode]').forEach((el) => {
      el.classList.toggle('is-current', el.dataset.otMode === state.mode);
    });
    this.shownClosed = step === 'closed';
    if (step === 'closed') this.$('[data-ot-closed-text]').textContent = withHours(t('closed_text'));
    if (step === 'choose') {
      // after the last delivery time the tile stays, greyed out, and says until when it was
      const tile = this.$('[data-ot-step="choose"] [data-ot-mode="delivery"]');
      const hint = tile?.querySelector('small');
      const off = !openNow().delivery;
      if (tile && hint) {
        if (this.deliveryHint == null) this.deliveryHint = hint.textContent;
        tile.classList.toggle('is-off', off);
        tile.setAttribute('aria-disabled', String(off));
        if (off) tile.classList.remove('is-current');
        hint.textContent = off ? withHours(t('delivery_until')) : this.deliveryHint;
      }
    }
    this.checkSeq++; // whatever was being checked belongs to the step we just left
    if (step !== 'address') return;
    this.setError('');
    this.setStatus('');
    // the address already on the order is the first row of the list: one tap keeps it
    const saved = state.address && state.address.line1 ? state.address : null;
    this.input.value = saved ? saved.line1 : '';
    this.renderSuggestions(saved ? [addressRow(saved)] : []);
    setTimeout(() => {
      this.input.focus();
      this.input.select();
    }, 60);
  }

  /** The bubble never asks twice: pickup is settled by the tap, delivery by picking the address. */
  choose(mode) {
    if (mode === 'delivery' && !openNow().delivery) return void this.show('choose');
    if (mode === 'delivery') return void this.show('address');
    if (!config().pickup) return;
    commit({ mode: 'pickup' });
    this.close();
  }

  /* ── small UI helpers ── */

  setError(message) {
    const el = this.$('[data-ot-error]');
    el.textContent = message || '';
    el.hidden = !message;
    this.$('[data-ot-field]').classList.toggle('is-error', Boolean(message));
  }

  fail(message) {
    this.setError(message);
    this.input.focus({ preventScroll: true });
    return false;
  }

  /** Under the field: '' (nothing), 'busy' (asking Shopify) or 'out' (we don't deliver there). */
  setStatus(status) {
    const offerPickup = status === 'out' && config().pickup;
    const note = this.$('[data-ot-result-address]');
    const switcher = this.$('[data-ot-switch]');
    this.result.hidden = !status;
    this.result.classList.toggle('is-busy', status === 'busy');
    this.$('[data-ot-result-title]').textContent = status ? t(status === 'busy' ? 'checking' : 'out_of_range') : '';
    note.textContent = offerPickup ? t('out_of_range_pickup') : '';
    note.hidden = !offerPickup;
    if (switcher) switcher.hidden = !offerPickup;
  }

  renderChip() {
    if (!this.chip) return;
    this.chip.hidden = this.dataset.chip !== 'true';
    const text = this.$('[data-ot-chip-text]');
    const closed = !openNow().open;
    this.chip.classList.toggle('is-closed', closed);
    this.chip.classList.toggle('is-empty', !state.mode && !closed);
    this.querySelectorAll('[data-ot-chip-icon]').forEach((icon) => {
      icon.toggleAttribute('hidden', icon.dataset.otChipIcon !== (state.mode === 'pickup' ? 'pickup' : 'delivery'));
    });
    if (closed) text.textContent = withHours(t('closed_chip'));
    else if (state.mode === 'delivery' && state.address) text.textContent = `${t('delivery')} · ${state.address.line1}`;
    else if (state.mode === 'pickup') text.textContent = `${t('pickup')} · ${config().store.address}`;
    else text.textContent = t('q_title');
  }

  /* ── address search ── */

  onInput() {
    clearTimeout(this.searchTimer);
    this.checkSeq++; // editing drops an answer that is still on its way
    this.setStatus('');
    this.setError('');
    const query = this.input.value.trim();
    if (query.length < 3) {
      this.searchSeq++;
      this.renderSuggestions([]);
      return;
    }
    this.searchTimer = setTimeout(() => this.search(query), 280);
  }

  async search(query) {
    const seq = ++this.searchSeq;
    let results = null;
    if (useGoogle()) {
      try {
        results = await googleSearch(query);
      } catch (_) {
        googleBroken = true; // key refused / script blocked → carry on with OpenStreetMap
      }
    }
    if (results === null) {
      try {
        results = await osmSearch(query, () => seq !== this.searchSeq);
      } catch (_) {
        if (seq === this.searchSeq) {
          this.renderSuggestions([]);
          this.setError(t('err_lookup'));
        }
        return;
      }
    }
    if (seq !== this.searchSeq) return; // a newer keystroke superseded this lookup
    this.renderSuggestions(results);
    this.setError(results.length ? '' : t('err_none'));
  }

  renderSuggestions(results) {
    this.suggestions = results;
    this.active = -1;
    this.list.replaceChildren(
      ...results.map((s, index) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'presentation');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'smoky-ot__suggestion';
        button.dataset.index = String(index);
        button.setAttribute('role', 'option');
        const title = document.createElement('strong');
        title.textContent = s.title;
        button.appendChild(title);
        if (s.subtitle) {
          const sub = document.createElement('span');
          sub.textContent = s.subtitle;
          button.appendChild(sub);
        }
        li.appendChild(button);
        return li;
      })
    );
    this.list.hidden = results.length === 0;
    this.input.setAttribute('aria-expanded', String(results.length > 0));
  }

  onKey(event) {
    const rows = [...this.list.querySelectorAll('[data-index]')];
    if (event.key === 'Escape' && !this.list.hidden) {
      event.preventDefault(); // close the list, not the bubble
      this.renderSuggestions([]);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const chosen = this.suggestions[this.active >= 0 ? this.active : 0];
      if (chosen && !this.list.hidden) this.pick(chosen);
      return;
    }
    if (!rows.length || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
    event.preventDefault();
    this.active = (this.active + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
    rows.forEach((row, index) => row.classList.toggle('is-active', index === this.active));
    rows[this.active].scrollIntoView?.({ block: 'nearest' });
  }

  async pick(suggestion) {
    if (!suggestion) return;
    const typed = this.input.value;
    let address = null;
    try {
      address = await suggestion.resolve();
    } catch (_) {
      return void this.fail(t('err_lookup'));
    }
    if (!address) return void this.fail(t('err_none'));
    const { extras } = parseAddressQuery(typed);
    if (extras.length && !address.extra) {
      const extra = extras.join(', ');
      address = { ...address, extra, label: `${address.label}, ${extra}` };
    }
    this.accept(address, typed);
  }

  /** Gatekeeper for every address, whether picked or located. */
  async accept(address, typed = '') {
    if (!address.precise) {
      // OpenStreetMap knows the street but not the house: take the number the customer typed
      const number = !useGoogle() && /(\d+\s?[A-Za-zА-Яа-я]?)\s*$/.exec(typed.trim())?.[1];
      if (number) {
        // the point is somewhere along the street, not this building: keep it only as an estimate
        address = typedNumberOn(address, number.replace(/\s+/g, '').toUpperCase());
      } else {
        // keep the street, ask for the number, search again from there
        this.renderSuggestions([]);
        this.input.value = `${address.line1} `;
        return void this.fail(t('err_number'));
      }
    }
    this.renderSuggestions([]);
    this.setError('');
    this.input.value = address.line1;
    this.setStatus('busy');
    const seq = ++this.checkSeq;
    let zone = null;
    try {
      zone = await resolveZone(address);
    } catch (_) {
      if (seq !== this.checkSeq) return;
      this.setStatus('');
      return void this.fail(t('err_lookup'));
    }
    if (seq !== this.checkSeq) return; // typed again, went back or closed meanwhile
    if (zone.out) return void this.setStatus('out');
    // We deliver there: nothing left to confirm — the fee and the minimum are shown in the cart.
    this.setStatus('');
    if (!openNow().delivery) return void this.show('choose'); // the last delivery minute passed meanwhile
    commit({ mode: 'delivery', address, zone });
    this.close();
  }

  /* ── "use my location" ── */

  locate() {
    if (!navigator.geolocation) return void this.fail(t('err_geo_denied'));
    if (this.locateButton.classList.contains('is-busy')) return;
    this.locateButton.classList.add('is-busy');
    this.renderSuggestions([]);
    this.checkSeq++;
    this.setStatus('');
    this.setError('');
    const placeholder = this.input.placeholder;
    this.input.value = '';
    this.input.placeholder = t('locating');
    const done = () => {
      this.locateButton.classList.remove('is-busy');
      this.input.placeholder = placeholder;
    };

    navigator.geolocation.getCurrentPosition(
      async ({ coords }) => {
        const { latitude: lat, longitude: lng } = coords;
        try {
          // far from Varna: no need to look the street up, we don't deliver there
          if (!inArea(lat, lng)) return void this.setStatus('out');
          let address = null;
          if (useGoogle()) {
            try {
              address = await googleReverse(lat, lng);
            } catch (_) {
              googleBroken = true;
            }
          }
          if (!address && !useGoogle()) address = await osmReverse(lat, lng);
          if (!address) return void this.fail(t('err_geo_fail'));
          if (!address.precise) return void (await this.accept(address)); // street only: asks for the number
          // Offered as a row to tap, never taken silently: the pin can land on the building next door.
          this.input.value = address.line1;
          this.renderSuggestions([addressRow(address)]);
        } catch (_) {
          this.fail(t('err_geo_fail'));
        } finally {
          done();
        }
      },
      (error) => {
        done();
        this.fail(t(error?.code === 1 ? 'err_geo_denied' : 'err_geo_fail'));
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
    );
  }
}

/* ── cart: the choice + the note ─────────────────────── */

class SmokyCartDelivery extends HTMLElement {
  connectedCallback() {
    this.$ = (selector) => this.querySelector(selector);
    this.onOrder = () => this.render();
    document.addEventListener('smoky:order', this.onOrder);
    if (!this.ready) {
      this.ready = true;
      this.noteInput = this.$('[data-dlv-note]');
      this.noteToggle = this.$('[data-dlv-note-toggle]');
      if (this.dataset.note) {
        this.noteInput.value = this.dataset.note;
        this.openNote(false);
      }
      this.noteToggle.addEventListener('click', () => {
        if (this.noteInput.hidden) this.openNote(true);
        else if (!this.noteInput.value.trim()) this.closeNote();
        else this.noteInput.focus();
      });
      this.noteInput.addEventListener('change', () => cartUpdate({ note: this.note }).catch(() => {}));
    }
    this.render();
  }

  disconnectedCallback() {
    document.removeEventListener('smoky:order', this.onOrder);
  }

  get note() {
    return this.noteInput.hidden ? '' : this.noteInput.value.trim();
  }

  openNote(focus) {
    this.noteInput.hidden = false;
    this.noteToggle.setAttribute('aria-expanded', 'true');
    if (focus) this.noteInput.focus();
  }

  closeNote() {
    this.noteInput.hidden = true;
    this.noteToggle.setAttribute('aria-expanded', 'false');
  }

  setError(message) {
    const el = this.$('[data-dlv-error="save"]');
    el.textContent = message || '';
    el.hidden = !message;
  }

  render() {
    const title = this.$('[data-dlv-choice-title]');
    const sub = this.$('[data-dlv-choice-sub]');
    const chosen = Boolean(state.mode);
    this.$('[data-dlv-choice]').classList.toggle('is-empty', !chosen);
    this.$('[data-dlv-change]').hidden = !chosen;
    this.querySelectorAll('[data-dlv-icon]').forEach((icon) => {
      icon.toggleAttribute('hidden', icon.dataset.dlvIcon !== (state.mode === 'pickup' ? 'pickup' : 'delivery'));
    });
    if (state.mode === 'delivery') {
      title.textContent = t('delivery_to');
      sub.textContent = state.address ? state.address.label : '';
    } else if (state.mode === 'pickup') {
      title.textContent = t('pickup_at');
      sub.textContent = config().store.address;
    } else {
      title.textContent = t('q_title');
      sub.textContent = '';
    }
    sub.hidden = !sub.textContent;
  }
}

/* ── cart: minimum-order progress ────────────────────── */

class SmokyCartProgress extends HTMLElement {
  static get observedAttributes() {
    return ['data-total'];
  }

  connectedCallback() {
    this.onOrder = () => this.render();
    document.addEventListener('smoky:order', this.onOrder);
    this.render();
  }

  disconnectedCallback() {
    document.removeEventListener('smoky:order', this.onOrder);
    cartDrawer()?.removeAttribute('data-smoky-lock');
  }

  // Shopify re-renders data-total on every cart change
  attributeChangedCallback() {
    if (this.isConnected) this.render();
  }

  get total() {
    return Number(this.dataset.total || 0);
  }

  render() {
    const drawer = cartDrawer();
    const status = orderStatus(state, this.total, openNow());
    if (drawer) {
      const wasLocked = drawer.getAttribute('data-smoky-lock');
      if (status.ok) drawer.removeAttribute('data-smoky-lock');
      else drawer.setAttribute('data-smoky-lock', status.reason);
      if (wasLocked === 'min' && status.ok) {
        drawer.classList.add('is-smoky-unlocked');
        setTimeout(() => drawer.classList.remove('is-smoky-unlocked'), 800);
      }
    }

    // state goes on the inner body: the drawer morph resets this element's own attributes
    const body = this.querySelector('[data-prog-body]');
    if (!body) return; // children not parsed yet
    // closed (or no more deliveries today): the line says so, there is no bar to fill
    const shut = status.reason === 'closed' || status.reason === 'delivery-closed';
    body.classList.toggle('is-closed', shut);
    if (shut) {
      body.hidden = false;
      body.classList.remove('is-done');
      this.querySelector('[data-prog-text]').textContent = withHours(t(status.reason === 'closed' ? 'closed_cart' : 'delivery_closed'));
      this.querySelector('[data-prog-meta]').textContent = status.reason === 'closed' ? '' : withHours(t('delivery_closed_hint'));
      return;
    }
    const zone = state.mode === 'delivery' && state.zone && !state.zone.out ? state.zone : null;
    body.hidden = !zone;
    if (!zone) return;
    const done = this.total >= zone.min;
    const percent = zone.min > 0 ? Math.min(100, Math.round((this.total / zone.min) * 100)) : 100;
    body.style.setProperty('--smoky-prog', `${percent}%`);
    body.classList.toggle('is-done', done);
    const text = this.querySelector('[data-prog-text]');
    if (done) {
      text.textContent = t('progress_done');
    } else {
      const [before, after = ''] = t('progress_more').split('[amount]');
      const amount = document.createElement('b');
      amount.textContent = money(zone.min - this.total);
      text.replaceChildren(before, amount, after);
    }
    this.querySelector('[data-prog-meta]').textContent = `${t('min_label')} ${money(zone.min)} · ${t('fee_label')} ${money(zone.fee)}`;
  }

  /** The locked checkout button was tapped: show what is missing. */
  nudge() {
    const body = this.querySelector('[data-prog-body]');
    if (!body) return;
    body.classList.remove('is-nudge');
    void body.offsetWidth;
    body.classList.add('is-nudge');
  }
}

/* ── checkout ────────────────────────────────────────── */

let checkoutBusy = false;

async function goToCheckout(button) {
  if (checkoutBusy) return;
  const delivery = document.querySelector('smoky-cart-delivery');
  const progress = document.querySelector('smoky-cart-progress');
  const status = orderStatus(state, progress ? progress.total : 0, openNow());
  if (!status.ok) {
    if (status.reason === 'min' || status.reason === 'closed') return void progress?.nudge();
    // no more deliveries today → back to the question, where only pickup can be chosen
    const step = status.reason === 'address' || status.reason === 'range' ? 'address' : 'choose';
    return void document.querySelector('smoky-order-type')?.open(step);
  }

  checkoutBusy = true;
  delivery?.setError('');
  button?.classList.add('is-smoky-busy');
  try {
    clearTimeout(cartSyncTimer);
    const cart = await withTimeout(cartUpdate({ attributes: cartAttributes(), note: delivery ? delivery.note : '' }), 8000);
    try {
      await withTimeout(prefillCheckout(cart?.token), 4000);
    } catch (_) {
      /* checkout still opens; the customer picks the address / pickup there */
    }
    window.location.assign(`${window.Shopify?.routes?.root || '/'}checkout`);
  } catch (_) {
    checkoutBusy = false;
    button?.classList.remove('is-smoky-busy');
    delivery?.setError(t('err_save'));
  }
}

if (!customElements.get('smoky-order-type')) customElements.define('smoky-order-type', SmokyOrderType);
if (!customElements.get('smoky-cart-delivery')) customElements.define('smoky-cart-delivery', SmokyCartDelivery);
if (!customElements.get('smoky-cart-progress')) customElements.define('smoky-cart-progress', SmokyCartProgress);

document.addEventListener(
  'click',
  (event) => {
    // the checkout button goes through the order choice first (before the cart form submits)
    const button = event.target.closest?.('button#checkout, button[name="checkout"]');
    if (button && document.querySelector('smoky-cart-delivery')) {
      event.preventDefault();
      event.stopPropagation();
      goToCheckout(button);
      return;
    }
    // the chip and the cart's choice card reopen the bubble
    const opener = event.target.closest?.('[data-ot-open]');
    if (opener) {
      event.preventDefault();
      event.stopPropagation();
      document.querySelector('smoky-order-type')?.open('choose');
    }
  },
  { capture: true }
);

// /cart is redirected to the menu with ?cart=open (layout/theme.liquid): open the drawer there.
if (new URLSearchParams(window.location.search).get('cart') === 'open') {
  const url = new URL(window.location.href);
  url.searchParams.delete('cart');
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  customElements.whenDefined('theme-drawer').then(() => {
    const drawer = cartDrawer();
    if (typeof drawer?.open === 'function') drawer.open();
  });
}
