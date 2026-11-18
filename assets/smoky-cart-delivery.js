/**
 * Smoky cart delivery details — behaviour for snippets/smoky-cart-delivery.liquid.
 *
 * The customer gives an exact address (picked from a lookup or from "use my location"),
 * a phone and an optional note inside the cart drawer. The script
 *   - accepts an address only when it comes from the lookup, so it always has a street +
 *     number (or block), city, postcode and coordinates: the form Google Maps shows and the
 *     form the Wolt courier API needs for a binding delivery promise;
 *   - keeps a Bulgarian mobile (or any full international number) in E.164, as Wolt requires;
 *   - saves everything on the cart (attributes + note) and puts the address and phone on the
 *     cart through the Storefront API, so checkout opens prefilled;
 *   - blocks „Поръчай“ until address and phone are valid.
 *
 * Lookup: Google Maps (Places + Geocoding) when the theme has an API key, otherwise
 * OpenStreetMap (Photon / Nominatim) — same UI, less precise house numbers.
 */

const LS_KEY = 'smoky_delivery_v1';
const ATTR = { address: 'Адрес за доставка', coords: 'Координати', zip: 'Пощенски код', phone: 'Телефон' };
const STOREFRONT_API = '/api/2026-10/graphql.json';

// Delivery region (Varna and its surroundings): lookups are limited to it and a
// "current location" outside it is refused. Addresses are always looked up in Bulgarian,
// whatever the site language — the kitchen and the courier read them.
const CENTER = { lat: 43.2141, lng: 27.9147 };
const AREA = { west: 27.6, south: 43.05, east: 28.2, north: 43.45 };
const DEFAULT_CITY = 'Варна';
const LOOKUP_LANG = 'bg';

const inArea = (lat, lng) => lat >= AREA.south && lat <= AREA.north && lng >= AREA.west && lng <= AREA.east;
const round6 = (n) => +Number(n).toFixed(6);

/* ── phone ───────────────────────────────────────────── */

/** E.164 for a Bulgarian mobile, or for any other full international number; '' when not valid. */
export function normalizePhone(raw) {
  const text = String(raw || '').trim();
  const international = text.startsWith('+') || text.startsWith('00');
  let digits = text.replace(/\D/g, '');
  if (text.startsWith('00')) digits = digits.slice(2);
  if (!international) {
    if (/^0[89]\d{8}$/.test(digits)) digits = `359${digits.slice(1)}`; // 0888 123 456
    else if (/^[89]\d{8}$/.test(digits)) digits = `359${digits}`; // 888 123 456
    else if (!/^359\d{9}$/.test(digits)) return ''; // 359 888 123 456 is fine as typed
  }
  if (digits.startsWith('359')) return /^359(8[7-9]|9[89])\d{7}$/.test(digits) ? `+${digits}` : '';
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : '';
}

/** +359888123456 → "+359 88 812 3456" (other countries are shown as they are). */
export function prettyPhone(e164) {
  const m = /^\+359(\d{2})(\d{3})(\d{4})$/.exec(e164 || '');
  return m ? `+359 ${m[1]} ${m[2]} ${m[3]}` : e164 || '';
}

/* ── lookups ─────────────────────────────────────────── */

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

/**
 * Address the rest of the script works with:
 * { line1, street, city, zip, lat, lng, label, precise }
 * `precise` = points at one building (street number / block), not just a street or district.
 */

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
    precise: Boolean(get('street_number') || get('premise') || get('subpremise')) || (types || []).some((t) => GOOGLE_PRECISE_TYPES.includes(t)),
  };
}

async function googleSearch(key, query) {
  const maps = await loadGoogle(key);
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

async function googleReverse(key, lat, lng) {
  const maps = await loadGoogle(key);
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

/* ── cart ────────────────────────────────────────────── */

async function cartUpdate(body) {
  const response = await fetch(window.Theme?.routes?.cart_update_url || '/cart/update.js', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error('cart_update_failed');
  return response.json();
}

/**
 * Put the address and phone on the cart itself (Storefront API, no token needed for cart
 * mutations), which is what makes checkout open with them filled in. Best effort: the cart
 * attributes already carry everything.
 */
async function prefillCheckout(cartToken, address, phone) {
  if (!cartToken || !address) return;
  const response = await fetch(STOREFRONT_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `mutation SmokyPrefill($id: ID!, $addresses: [CartSelectableAddressInput!]!, $buyer: CartBuyerIdentityInput!) {
        cartDeliveryAddressesReplace(cartId: $id, addresses: $addresses) { userErrors { code message } }
        cartBuyerIdentityUpdate(cartId: $id, buyerIdentity: $buyer) { userErrors { code message } }
      }`,
      variables: {
        id: `gid://shopify/Cart/${cartToken}`,
        addresses: [
          {
            selected: true,
            oneTimeUse: true,
            address: { deliveryAddress: { address1: address.line1, city: address.city, zip: address.zip || '', countryCode: 'BG', phone: phone || null } },
          },
        ],
        buyer: { countryCode: 'BG', phone: phone || null },
      },
    }),
  });
  if (!response.ok) throw new Error('prefill_failed');
}

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

/* ── the element ─────────────────────────────────────── */

class SmokyCartDelivery extends HTMLElement {
  connectedCallback() {
    if (this.ready) return;
    this.ready = true;

    this.$ = (selector) => this.querySelector(selector);
    this.addressInput = this.$('[data-dlv-address]');
    this.phoneInput = this.$('[data-dlv-phone]');
    this.noteInput = this.$('[data-dlv-note]');
    this.noteToggle = this.$('[data-dlv-note-toggle]');
    this.list = this.$('[data-dlv-suggestions]');
    this.locateButton = this.$('[data-dlv-locate]');
    try {
      this.strings = JSON.parse(this.$('[data-dlv-strings]')?.textContent || '{}');
    } catch (_) {
      this.strings = {};
    }
    this.mapsKey = this.dataset.mapsKey || '';

    this.state = { address: null, phone: '', note: '' };
    this.suggestions = [];
    this.active = -1;
    this.searchSeq = 0;
    this.restore();
    this.bind();
  }

  /* state ← cart attributes (this cart) or the last order on this device */
  restore() {
    let remembered = null;
    try {
      remembered = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    } catch (_) {
      remembered = null;
    }
    const onCart = this.dataset.address || '';
    let address = null;
    if (remembered?.address?.line1 && (!onCart || onCart === remembered.address.label)) {
      address = remembered.address;
    } else if (onCart) {
      const [lat, lng] = (this.dataset.coords || '').split(',').map(Number);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        address = { line1: onCart.split(',')[0].trim(), street: onCart.split(',')[0].trim(), city: DEFAULT_CITY, zip: this.dataset.zip || '', lat, lng, label: onCart, precise: true };
      }
    }
    const phone = normalizePhone(this.dataset.phone) || normalizePhone(remembered?.phone);

    if (address) this.showAddress(address);
    if (phone) {
      this.state.phone = phone;
      this.phoneInput.value = prettyPhone(phone);
    }
    if (this.dataset.note) {
      this.state.note = this.dataset.note;
      this.noteInput.value = this.dataset.note;
      this.openNote(false);
    }
    // a returning customer's details are not on a fresh cart yet
    if ((address && !onCart) || (phone && !this.dataset.phone)) this.save();
  }

  bind() {
    this.addressInput.addEventListener('input', () => this.onAddressInput());
    this.addressInput.addEventListener('keydown', (event) => this.onAddressKey(event));
    this.addressInput.addEventListener('focus', () => {
      if (!this.state.address && this.suggestions.length) this.renderSuggestions(this.suggestions);
    });
    this.list.addEventListener('click', (event) => {
      const row = event.target.closest('[data-index]');
      if (row) this.pick(this.suggestions[Number(row.dataset.index)]);
    });
    // leaving the address field closes the list (a click on a row lands first)
    this.$('[data-dlv-field="address"]').addEventListener('focusout', (event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setTimeout(() => this.renderSuggestions([], { keep: true }), 150);
    });
    this.locateButton.addEventListener('click', () => this.locate());

    this.phoneInput.addEventListener('input', () => this.setError('phone', ''));
    this.phoneInput.addEventListener('change', () => this.commitPhone(true));
    this.phoneInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.commitPhone(true);
      }
    });

    this.noteToggle.addEventListener('click', () => {
      if (this.noteInput.hidden) this.openNote(true);
      else if (!this.noteInput.value.trim()) this.closeNote();
      else this.noteInput.focus();
    });
    this.noteInput.addEventListener('change', () => {
      this.state.note = this.noteInput.value.trim();
      this.save();
    });
  }

  /* ── small UI helpers ── */

  t(key) {
    return this.strings[key] || '';
  }

  setError(name, message) {
    const el = this.$(`[data-dlv-error="${name}"]`);
    if (el) {
      el.textContent = message || '';
      el.hidden = !message;
    }
    this.$(`[data-dlv-field="${name}"]`)?.classList.toggle('is-error', Boolean(message));
  }

  /** Show the problem, bring the field into view and put the cursor in it. */
  fail(name, message) {
    this.setError(name, message);
    const input = name === 'phone' ? this.phoneInput : this.addressInput;
    input.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    input.focus({ preventScroll: true });
    return false;
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

  showAddress(address) {
    this.state.address = address;
    this.addressInput.value = address.line1;
    const ok = this.$('[data-dlv-address-ok]');
    this.$('[data-dlv-address-ok-text]').textContent = address.label;
    ok.hidden = false;
    this.setError('address', '');
    this.renderSuggestions([]);
  }

  clearAddress() {
    this.state.address = null;
    this.$('[data-dlv-address-ok]').hidden = true;
  }

  /* ── address search ── */

  useGoogle() {
    return Boolean(this.mapsKey) && !googleBroken;
  }

  onAddressInput() {
    clearTimeout(this.searchTimer);
    this.clearAddress(); // editing invalidates the previous choice and its coordinates
    this.setError('address', '');
    const query = this.addressInput.value.trim();
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
    if (this.useGoogle()) {
      try {
        results = await googleSearch(this.mapsKey, query);
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
          this.setError('address', this.t('err_lookup'));
        }
        return;
      }
    }
    if (seq !== this.searchSeq) return; // a newer keystroke superseded this lookup
    this.renderSuggestions(results);
    this.setError('address', results.length ? '' : this.t('err_none'));
  }

  renderSuggestions(results, { keep = false } = {}) {
    if (!keep) this.suggestions = results;
    this.active = -1;
    this.list.replaceChildren(
      ...results.map((s, index) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'presentation');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'smoky-dlv__suggestion';
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
    this.addressInput.setAttribute('aria-expanded', String(results.length > 0));
  }

  onAddressKey(event) {
    const rows = [...this.list.querySelectorAll('[data-index]')];
    if (event.key === 'Escape') {
      this.renderSuggestions([], { keep: true });
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
    const typed = this.addressInput.value;
    let address = null;
    try {
      address = await suggestion.resolve();
    } catch (_) {
      this.fail('address', this.t('err_lookup'));
      return;
    }
    if (!address) return void this.fail('address', this.t('err_none'));
    this.accept(address, typed);
  }

  /** Gatekeeper for every address, whether picked or located. */
  accept(address, typed = '') {
    if (!inArea(address.lat, address.lng)) return void this.fail('address', this.t('err_area'));
    if (!address.precise) {
      // OpenStreetMap knows the street but not the house: take the number the customer typed
      const number = !this.useGoogle() && /(\d+\s?[A-Za-zА-Яа-я]?)\s*$/.exec(typed.trim())?.[1];
      if (number) {
        const line1 = `${address.street} ${number.replace(/\s+/g, '')}`;
        address = { ...address, line1, label: address.label.replace(address.line1, line1), precise: true };
      } else {
        // keep the street, ask for the number, search again from there
        this.renderSuggestions([]);
        this.addressInput.value = `${address.line1} `;
        this.clearAddress();
        this.fail('address', this.t('err_number'));
        return;
      }
    }
    this.showAddress(address);
    this.save();
  }

  /* ── "use my location" ── */

  locate() {
    if (!navigator.geolocation) return void this.fail('address', this.t('err_geo_denied'));
    if (this.locateButton.classList.contains('is-busy')) return;
    this.locateButton.classList.add('is-busy');
    this.renderSuggestions([]);
    this.clearAddress();
    this.setError('address', '');
    const placeholder = this.addressInput.placeholder;
    this.addressInput.value = '';
    this.addressInput.placeholder = this.t('locating');
    const done = () => {
      this.locateButton.classList.remove('is-busy');
      this.addressInput.placeholder = placeholder;
    };

    navigator.geolocation.getCurrentPosition(
      async ({ coords }) => {
        const { latitude: lat, longitude: lng } = coords;
        try {
          if (!inArea(lat, lng)) return void this.fail('address', this.t('err_area'));
          let address = null;
          if (this.useGoogle()) {
            try {
              address = await googleReverse(this.mapsKey, lat, lng);
            } catch (_) {
              googleBroken = true;
            }
          }
          if (!address && !this.useGoogle()) address = await osmReverse(lat, lng);
          if (!address) return void this.fail('address', this.t('err_geo_fail'));
          this.accept(address);
        } catch (_) {
          this.fail('address', this.t('err_geo_fail'));
        } finally {
          done();
        }
      },
      (error) => {
        done();
        this.fail('address', this.t(error?.code === 1 ? 'err_geo_denied' : 'err_geo_fail'));
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
    );
  }

  /* ── phone ── */

  /** Validate what is typed; `report` shows the error for a non-empty invalid number. */
  commitPhone(report = false) {
    const raw = this.phoneInput.value.trim();
    const phone = normalizePhone(raw);
    if (!phone) {
      this.state.phone = '';
      if (report && raw) this.setError('phone', this.t('err_phone'));
      return false;
    }
    this.setError('phone', '');
    this.phoneInput.value = prettyPhone(phone);
    if (phone !== this.state.phone) {
      this.state.phone = phone;
      this.save();
    }
    return true;
  }

  /* ── saving ── */

  payload() {
    const { address, phone, note } = this.state;
    return {
      attributes: {
        [ATTR.address]: address ? address.label : '',
        [ATTR.coords]: address ? `${address.lat},${address.lng}` : '',
        [ATTR.zip]: address ? address.zip || '' : '',
        [ATTR.phone]: phone || '',
      },
      note: note || '',
    };
  }

  /** Save to the cart shortly after the last change (and remember address + phone on this device). */
  save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ address: this.state.address, phone: this.state.phone }));
    } catch (_) {
      /* private mode: the cart still gets it */
    }
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveNow().catch(() => {}); // checkout saves again and reports a failure there
    }, 300);
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    return cartUpdate(this.payload());
  }

  /* ── checkout ── */

  async checkout(button) {
    if (this.busy) return;
    this.setError('save', '');
    this.commitPhone();
    if (!this.state.address) return void this.fail('address', this.t(this.addressInput.value.trim() ? 'err_pick' : 'err_address'));
    if (!this.state.phone) return void this.fail('phone', this.t('err_phone'));
    this.state.note = this.noteInput.hidden ? '' : this.noteInput.value.trim();

    this.busy = true;
    button?.classList.add('is-smoky-busy');
    try {
      const cart = await withTimeout(this.saveNow(), 8000);
      try {
        await withTimeout(prefillCheckout(cart?.token, this.state.address, this.state.phone), 4000);
      } catch (_) {
        /* checkout still opens; the customer types the address there */
      }
      window.location.assign(`${window.Shopify?.routes?.root || '/'}checkout`);
    } catch (_) {
      this.busy = false;
      button?.classList.remove('is-smoky-busy');
      this.setError('save', this.t('err_save'));
    }
  }
}

if (!customElements.get('smoky-cart-delivery')) customElements.define('smoky-cart-delivery', SmokyCartDelivery);

// „Поръчай“ goes through the delivery details first (capture phase: before the cart form submits).
document.addEventListener(
  'click',
  (event) => {
    const button = event.target.closest?.('button#checkout, button[name="checkout"]');
    if (!button) return;
    const delivery = document.querySelector('smoky-cart-delivery');
    if (!delivery?.checkout) return;
    event.preventDefault();
    event.stopPropagation();
    delivery.checkout(button);
  },
  { capture: true }
);

// /cart is redirected to the menu with ?cart=open (layout/theme.liquid): open the drawer there.
if (new URLSearchParams(window.location.search).get('cart') === 'open') {
  const url = new URL(window.location.href);
  url.searchParams.delete('cart');
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  customElements.whenDefined('theme-drawer').then(() => {
    const drawer = document.querySelector('theme-drawer#cart-drawer');
    if (typeof drawer?.open === 'function') drawer.open();
  });
}
