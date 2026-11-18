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
 * every minimum), so the cart can never promise something checkout will refuse. The distance
 * table from the theme settings is only the offline fallback.
 *
 * The choice is saved on the cart (attributes „Получаване“, „Адрес за доставка“, „Координати“,
 * „Пощенски код“ + the note) and handed to checkout through the Storefront API (delivery
 * address / pickup preference), so checkout opens with it already filled in.
 *
 * Lookup: Google Maps (Places + Geocoding) when the theme has an API key, otherwise
 * OpenStreetMap (Photon / Nominatim) — same UI, less precise house numbers.
 */

const LS_KEY = 'smoky_order_v2';
const SS_ASKED = 'smoky_order_asked';
const ATTR = { mode: 'Получаване', address: 'Адрес за доставка', coords: 'Координати', zip: 'Пощенски код', phone: 'Телефон' };
// order attribute values the kitchen / bridge read (same wording as the other restaurants' shops)
const MODE_VALUE = { delivery: 'Доставка', pickup: 'Вземане от място' };
const STOREFRONT_API = '/api/2026-10/graphql.json';

// Lookups are limited to Varna and its surroundings, and always answered in Bulgarian,
// whatever the site language — the kitchen and the courier read the address.
const CENTER = { lat: 43.2141, lng: 27.9147 };
const AREA = { west: 27.6, south: 43.05, east: 28.2, north: 43.45 };
const DEFAULT_CITY = 'Варна';
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
    mapsKey: d.mapsKey || '',
    probeVariant: d.probeVariant || '',
    probePrice: Number(d.probePrice || 0),
    strings,
  };
  if (el) cachedConfig = result;
  return result;
}

const t = (key) => config().strings[key] || '';

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
  document.dispatchEvent(new CustomEvent('smoky:order', { detail: state }));
}

function cartAttributes() {
  const address = state.mode === 'delivery' ? state.address : null;
  return {
    [ATTR.mode]: state.mode ? MODE_VALUE[state.mode] : '',
    [ATTR.address]: address ? address.label : '',
    // an approximate point (street matched, house number typed) is not sent as the drop-off pin
    [ATTR.coords]: address && address.lat != null && !address.approx ? `${address.lat},${address.lng}` : '',
    [ATTR.zip]: address ? address.zip || '' : '',
    [ATTR.phone]: '', // the phone is collected at checkout now
  };
}

/** Can this cart go to checkout? `reason`: choose | address | range | min. */
export function orderStatus(current, totalCents) {
  if (!current.mode) return { ok: false, reason: 'choose' };
  if (current.mode === 'pickup') return { ok: true };
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
  address: { deliveryAddress: { address1: address.line1, city: address.city || DEFAULT_CITY, zip: address.zip || '', countryCode: 'BG' } },
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

/** { min, fee } for the address, or { out: true } when it is outside every zone. */
async function resolveZone(address) {
  const { zones, store } = config();
  try {
    // Local delivery is the only way to ship, so "no option" = Shopify will not deliver there.
    // Asked twice before it is believed: a single empty answer can be a hiccup.
    let fee = await withTimeout(probeFee(address), 7000);
    if (fee == null) fee = await withTimeout(probeFee(address), 7000);
    return fee == null ? { out: true } : zoneForFee(zones, fee);
  } catch (error) {
    if (address.lat == null || !Number.isFinite(store.lat) || !Number.isFinite(store.lng)) throw error;
    return zoneForDistance(zones, distanceKm(store, address));
  }
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

async function osmSearch(query) {
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
  const seen = new Set();
  const out = [];
  for (const feature of data?.features || []) {
    const address = fromPhoton(feature);
    if (!address || seen.has(address.label)) continue; // several shops at one address → one row
    seen.add(address.label);
    out.push({ title: address.line1, subtitle: address.label.split(', ').slice(1).join(', '), resolve: async () => address });
    if (out.length === 6) break;
  }
  return out;
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
    this.addressConfirm = this.$('[data-ot-step="address"] [data-ot-confirm]');

    this.suggestions = [];
    this.active = -1;
    this.searchSeq = 0;
    this.pending = null; // { address, zone } picked in the bubble, not confirmed yet
    this.reopenDrawer = false;

    this.bind();
    this.renderChip();
    document.addEventListener('smoky:order', () => this.renderChip());

    // the cart may have lost the choice (new cart, other tab): put it back
    if (state.mode && (this.dataset.cartMode || '') !== MODE_VALUE[state.mode]) commit({});

    let asked = false;
    try {
      asked = Boolean(sessionStorage.getItem(SS_ASKED));
    } catch (_) {
      asked = false;
    }
    if (this.dataset.auto === 'true' && !state.mode && !asked) setTimeout(() => this.open('choose'), 900);
  }

  bind() {
    this.addEventListener('click', (event) => {
      const mode = event.target.closest('[data-ot-mode]');
      if (mode) return void this.choose(mode.dataset.otMode);
      if (event.target.closest('[data-ot-back]')) return void this.show('choose');
      if (event.target.closest('[data-ot-close]')) return void this.close();
      if (event.target.closest('[data-ot-confirm]')) return void this.confirm();
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
    this.show(step);
    if (!this.dialog.open) this.dialog.showModal();
  }

  close() {
    if (this.dialog.open) this.dialog.close();
  }

  onClosed() {
    try {
      sessionStorage.setItem(SS_ASKED, '1'); // asked once per visit; the chip and the cart keep offering it
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
    if (step !== 'address') return;
    this.setError('');
    this.renderSuggestions([]);
    if (state.mode === 'delivery' && state.address && state.zone) {
      this.pending = { address: state.address, zone: state.zone };
      this.input.value = state.address.line1;
    } else if (!this.pending) {
      this.input.value = '';
    }
    this.renderResult();
    if (!this.input.value) setTimeout(() => this.input.focus(), 60);
  }

  choose(mode) {
    if (mode === 'pickup' && !config().pickup) return;
    this.show(mode === 'delivery' ? 'address' : 'pickup');
  }

  confirm() {
    const pickupStep = !this.$('[data-ot-step="pickup"]').hidden;
    if (pickupStep) {
      commit({ mode: 'pickup' });
      return void this.close();
    }
    if (!this.pending) return void this.fail(t(this.input.value.trim() ? 'err_pick' : 'err_address'));
    if (this.pending.zone.out) return;
    commit({ mode: 'delivery', address: this.pending.address, zone: this.pending.zone });
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

  setBusy(busy) {
    this.addressConfirm.classList.toggle('is-busy', busy);
    if (busy) {
      this.result.hidden = false;
      this.result.classList.remove('is-out');
      this.$('[data-ot-result-title]').textContent = t('checking');
      this.$('[data-ot-result-address]').textContent = '';
      this.$('[data-ot-facts]').hidden = true;
      const switcher = this.$('[data-ot-switch]');
      if (switcher) switcher.hidden = true;
    }
  }

  /** The answer for the picked address: fee + minimum, or "we don't deliver there (yet)". */
  renderResult() {
    const pending = this.pending;
    const switcher = this.$('[data-ot-switch]');
    this.result.hidden = !pending;
    this.addressConfirm.disabled = !pending || Boolean(pending.zone.out);
    if (!pending) return;
    const out = Boolean(pending.zone.out);
    this.result.classList.toggle('is-out', out);
    this.$('[data-ot-result-title]').textContent = t(out ? 'out_of_range' : 'zone_ok');
    this.$('[data-ot-result-address]').textContent = out && config().pickup ? t('out_of_range_pickup') : pending.address.label;
    this.$('[data-ot-facts]').hidden = out;
    if (!out) {
      this.$('[data-ot-fee]').textContent = money(pending.zone.fee);
      this.$('[data-ot-min]').textContent = money(pending.zone.min);
    }
    if (switcher) switcher.hidden = !out;
  }

  renderChip() {
    if (!this.chip) return;
    this.chip.hidden = this.dataset.chip !== 'true';
    const text = this.$('[data-ot-chip-text]');
    this.chip.classList.toggle('is-empty', !state.mode);
    this.querySelectorAll('[data-ot-chip-icon]').forEach((icon) => {
      icon.toggleAttribute('hidden', icon.dataset.otChipIcon !== (state.mode === 'pickup' ? 'pickup' : 'delivery'));
    });
    if (state.mode === 'delivery' && state.address) text.textContent = `${t('delivery')} · ${state.address.line1}`;
    else if (state.mode === 'pickup') text.textContent = `${t('pickup')} · ${config().store.address}`;
    else text.textContent = t('q_title');
  }

  /* ── address search ── */

  onInput() {
    clearTimeout(this.searchTimer);
    this.pending = null; // editing invalidates the previous choice
    this.renderResult();
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
        results = await osmSearch(query);
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
      else if (this.pending) this.confirm();
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
    this.accept(address, typed);
  }

  /** Gatekeeper for every address, whether picked or located. */
  async accept(address, typed = '') {
    if (!address.precise) {
      // OpenStreetMap knows the street but not the house: take the number the customer typed
      const number = !useGoogle() && /(\d+\s?[A-Za-zА-Яа-я]?)\s*$/.exec(typed.trim())?.[1];
      if (number) {
        // the point is somewhere along the street, not this building: keep it only as an estimate
        const line1 = `${address.street} ${number.replace(/\s+/g, '')}`;
        address = { ...address, line1, label: `${line1}, ${address.city}`, zip: '', approx: true, precise: true };
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
    this.pending = null;
    this.setBusy(true);
    let zone = null;
    try {
      zone = await resolveZone(address);
    } catch (_) {
      this.setBusy(false);
      this.result.hidden = true;
      return void this.fail(t('err_lookup'));
    }
    this.setBusy(false);
    this.pending = { address, zone };
    this.renderResult();
    if (!zone.out) this.addressConfirm.focus({ preventScroll: true });
  }

  /* ── "use my location" ── */

  locate() {
    if (!navigator.geolocation) return void this.fail(t('err_geo_denied'));
    if (this.locateButton.classList.contains('is-busy')) return;
    this.locateButton.classList.add('is-busy');
    this.renderSuggestions([]);
    this.pending = null;
    this.renderResult();
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
          if (!inArea(lat, lng)) {
            this.pending = { address: { line1: '', label: '', lat, lng }, zone: { out: true } };
            return void this.renderResult();
          }
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
          await this.accept(address);
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
    const status = orderStatus(state, this.total);
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
  const status = orderStatus(state, progress ? progress.total : 0);
  if (!status.ok) {
    if (status.reason === 'min') return void progress?.nudge();
    return void document.querySelector('smoky-order-type')?.open(status.reason === 'choose' ? 'choose' : 'address');
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
