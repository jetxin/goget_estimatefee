export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const providedToken = (req.query && req.query.token) || null;
  if (process.env.RATE_CALLBACK_TOKEN && providedToken !== process.env.RATE_CALLBACK_TOKEN) {
    return res.status(401).json({ rates: [] });
  }

  try {
    const body = req.body || {};
    const rate = body.rate || {};

    const gogetEndpoint = process.env.GOGET_API_ENDPOINT;
    const gogetToken = process.env.GOGET_API_TOKEN;
    if (!gogetEndpoint || !gogetToken) {
      return res.json(maybeDebug({ rates: [], reason: "missing_goget_env" }));
    }
    const authorizationHeader = `Token token=${gogetToken}`;

    const pickupName = process.env.DEFAULT_PICKUP_NAME || rate.origin?.name || "Shop Origin";

    const pickupAddress = joinAddress(rate.origin);
    const dropoffAddress = joinAddress(rate.destination);

    if (!pickupAddress || !dropoffAddress) {
      return res.json(maybeDebug({ rates: [], reason: "missing_addresses" }));
    }

    // Normalize country for Nominatim bias
    const countryBias = normalizeCountry(rate.destination?.country || rate.origin?.country);

    // Pickup geocode (env fallback → geocode)
    const pickupGeo = await resolveGeo({
      address: pickupAddress,
      countryBias,
      fallbackEnvLat: toNum(process.env.DEFAULT_PICKUP_LAT),
      fallbackEnvLng: toNum(process.env.DEFAULT_PICKUP_LNG),
    });

    if (!pickupGeo) {
      return res.json(maybeDebug({ rates: [], reason: "geocode_pickup_failed" }));
    }

    // Dropoff geocode (always via lookup, biased near pickup)
    const dropoffGeo = await resolveGeo({
      address: dropoffAddress,
      countryBias,
      near: pickupGeo,
    });

    if (!dropoffGeo) {
      return res.json(maybeDebug({ rates: [], reason: "geocode_dropoff_failed" }));
    }

    const startAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    const gogetPayload = {
      pickup: {
        name: pickupName,
        location: pickupAddress,
        location_lat: pickupGeo.lat,
        location_long: pickupGeo.lng,
        parking: true,
        start_at: startAt,
      },
      dropoff: [
        {
          location: dropoffAddress,
          location_lat: dropoffGeo.lat,
          location_long: dropoffGeo.lng,
        },
      ],
      ride_id: 2,
      bulky: false,
      guarantee: true,
      num_of_items: "1-2",
      flexi: false,
      route: false,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const ggResp = await fetch(gogetEndpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: authorizationHeader,
      },
      body: JSON.stringify(gogetPayload),
      signal: controller.signal,
    }).catch(() => null);
    clearTimeout(timeout);

    if (!ggResp || !ggResp.ok) {
      const text = await safeText(ggResp);
      return res.json(maybeDebug({ rates: [], reason: "goget_bad_response", status: ggResp?.status, body: text }));
    }

    const quote = await ggResp.json();
    const fee =
      toNum(quote?.data?.fee) ??
      toNum(quote?.total_fee) ??
      toNum(quote?.fee);

    if (!Number.isFinite(fee)) {
      return res.json(maybeDebug({ rates: [], reason: "no_fee_in_response", quote }));
    }

    const priceMinor = Math.round(fee * 100);
    const shopCurrency = rate.currency || "MYR";

    const responseBody = {
      rates: [
        {
          service_name: "GoGet Delivery",
          service_code: "GOGET_NOW",
          description: "Real-time courier delivery via GoGet",
          total_price: String(priceMinor),
          currency: shopCurrency,
        },
      ],
    };

    return res.json(maybeDebug({ ...responseBody, gogetFee: fee, payloadSent: maybePayload(gogetPayload) }));
  } catch (e) {
    console.error("Handler error:", e);
    return res.status(500).json({
      rates: [],
      reason: e.message || "unhandled_error",
      stack: process.env.DEBUG === "1" ? e.stack : undefined,
    });
  }
}

/**
 * Helpers
 */

// ✅ Normalization maps
const stateMap = {
  JHR: "Johor",
  KDH: "Kedah",
  KTN: "Kelantan",
  MLK: "Melaka",
  NSN: "Negeri Sembilan",
  PHG: "Pahang",
  PRK: "Perak",
  PLS: "Perlis",
  PNG: "Pulau Pinang",
  SGR: "Selangor",
  TRG: "Terengganu",
  SBH: "Sabah",
  SWK: "Sarawak",
  KUL: "Kuala Lumpur",
  LBN: "Labuan",
  PJY: "Putrajaya",
};

const countryMap = {
  MY: "Malaysia",
  malaysia: "Malaysia",
};

function joinAddress(part) {
  if (!part) return "";
  return [
    part.address1,
    part.city,
    part.postal_code || part.zip,
    normalizeState(part.province),
    normalizeCountryFull(part.country),
  ]
    .map((s) => (s || "").trim())
    .filter(Boolean)
    .join(", ");
}

function normalizeState(stateCodeOrName = "") {
  if (!stateCodeOrName) return "";
  const upper = stateCodeOrName.toUpperCase();
  return stateMap[upper] || stateCodeOrName;
}

function normalizeCountry(codeOrName = "") {
  if (!codeOrName) return "";
  const lower = codeOrName.toLowerCase();
  if (lower === "my" || lower === "malaysia") return "my"; // for bias param
  return "";
}

function normalizeCountryFull(codeOrName = "") {
  if (!codeOrName) return "";
  const upper = codeOrName.toUpperCase();
  return countryMap[upper] || codeOrName;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function maybeDebug(obj) {
  return process.env.DEBUG === "1" ? obj : { rates: obj.rates || [] };
}

function maybePayload(p) {
  return process.env.DEBUG === "1" ? p : undefined;
}

async function safeText(resp) {
  if (!resp) return "";
  try {
    return await resp.text();
  } catch {
    return "";
  }
}

/**
 * Reusable geocode resolver
 */
async function resolveGeo({ address, countryBias = "", fallbackEnvLat = null, fallbackEnvLng = null, near = null }) {
  // Step 1: env fallback (pickup)
  if (Number.isFinite(fallbackEnvLat) && Number.isFinite(fallbackEnvLng)) {
    return { lat: fallbackEnvLat, lng: fallbackEnvLng };
  }

  // Step 2: geocode via Nominatim
  if (!address) return null;
  const params = new URLSearchParams({
    q: address,
    format: "json",
    limit: "1",
  });

  if (countryBias) params.set("countrycodes", countryBias);
  if (near?.lat && near?.lng) {
    params.set("viewbox", [
      near.lng - 0.1,
      near.lat + 0.1,
      near.lng + 0.1,
      near.lat - 0.1,
    ].join(","));
    // no bounded=1 → keeps results flexible
  }

  const url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;
  console.log("Geocode query:", url);

  const resp = await fetch(url, {
    headers: { "User-Agent": "Shopify-CarrierService-Demo/1.0 jetxin@live.com" },
  }).catch((err) => {
    console.error("Geocode fetch error:", err);
    return null;
  });

  if (!resp || !resp.ok) return null;

  const results = await resp.json().catch(() => []);
  if (!results.length) return null;

  return {
    lat: parseFloat(results[0].lat),
    lng: parseFloat(results[0].lon),
  };
}
