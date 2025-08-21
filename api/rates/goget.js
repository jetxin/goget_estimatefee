export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  // Auth via query token (Shopify cannot send custom headers)
  const providedToken =
    (req.query && req.query.token) ||
    null;

  if (process.env.RATE_CALLBACK_TOKEN && providedToken !== process.env.RATE_CALLBACK_TOKEN) {
    return res.status(401).json({ rates: [] });
  }

  try {
    const body = req.body || {};
    const rate = body.rate || {};

    // Required env
    const gogetEndpoint = process.env.GOGET_API_ENDPOINT;
    const gogetToken = process.env.GOGET_API_TOKEN; // just the token value
    if (!gogetEndpoint || !gogetToken) {
      return res.json(maybeDebug({ rates: [], reason: "missing_goget_env" }));
    }
    const authorizationHeader = `Token token=${gogetToken}`;

    // Build pickup and dropoff from Shopify payload
    const pickupName =
      process.env.DEFAULT_PICKUP_NAME ||
      rate.origin?.name ||
      "Shop Origin";

    const pickupAddress = joinAddress(rate.origin);
    const dropoffAddress = joinAddress(rate.destination);

    if (!pickupAddress || !dropoffAddress) {
      return res.json(maybeDebug({ rates: [], reason: "missing_addresses" }));
    }

    // Resolve coordinates
    const countryBias = (rate.destination?.country || rate.origin?.country || "").toLowerCase();
    const pickupLatEnv = toNum(process.env.DEFAULT_PICKUP_LAT);
    const pickupLngEnv = toNum(process.env.DEFAULT_PICKUP_LNG);

    // Prefer env pickup coords if provided (avoid geocoding pickup each call)
    const pickupGeo = Number.isFinite(pickupLatEnv) && Number.isFinite(pickupLngEnv)
      ? { lat: pickupLatEnv, lng: pickupLngEnv }
      : await geocodeAddress(pickupAddress, countryBias);

    if (!pickupGeo) {
      return res.json(maybeDebug({ rates: [], reason: "geocode_pickup_failed" }));
    }

    // Bias dropoff around pickup
    const dropoffGeo = await geocodeAddress(dropoffAddress, countryBias, pickupGeo);
    if (!dropoffGeo) {
      return res.json(maybeDebug({ rates: [], reason: "geocode_dropoff_failed" }));
    }

    // Start time: now + 5 minutes
    const startAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    // GoGet payload
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

    // Call GoGet
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

    const priceMinor = Math.round(fee * 100); // RM 13.00 -> "1300"
    const responseBody = {
      rates: [
        {
          service_name: "GoGet Delivery",
          service_code: "GOGET_NOW",
          total_price: String(priceMinor),
          currency: rate.currency || "MYR",
        },
      ],
    };

    return res.json(maybeDebug({ ...responseBody, gogetFee: fee, payloadSent: maybePayload(gogetPayload) }));
  } catch (e) {
    return res.json(maybeDebug({ rates: [], reason: "unhandled_error" }));
  }
}

function joinAddress(part) {
  if (!part) return "";
  return [
    part.address1,
    part.address2,
    part.city,
    part.province,
    part.postal_code || part.zip,
    part.country,
  ].filter(Boolean).join(", ");
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function buildViewbox(lat, lng, delta = 0.27) {
  const left = (lng - delta).toFixed(6);
  const right = (lng + delta).toFixed(6);
  const top = (lat + delta).toFixed(6);
  const bottom = (lat - delta).toFixed(6);
  return `${left},${top},${right},${bottom}`;
}

async function geocodeAddress(address, countryCodeLower, bias) {
  if (!address) return null;

  const params = new URLSearchParams({
    format: "jsonv2",
    q: address,
    limit: "1",
    addressdetails: "0",
  });
  if (countryCodeLower) params.set("countrycodes", countryCodeLower);
  if (bias && Number.isFinite(bias.lat) && Number.isFinite(bias.lng)) {
    params.set("viewbox", buildViewbox(bias.lat, bias.lng));
    params.set("bounded", "1");
  }

  const headers = {
    Accept: "application/json",
    "User-Agent": `goget-carrier/1.0 (${process.env.NOMINATIM_EMAIL || "email@example.com"})`,
  };

  const tryOnce = async (timeoutMs) => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
        headers,
        signal: controller.signal,
      });
      if (!r.ok) return null;
      const arr = await r.json();
      if (!Array.isArray(arr) || arr.length === 0) return null;
      const { lat, lon } = arr[0];
      const latNum = Number(lat);
      const lngNum = Number(lon);
      if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) return null;
      return { lat: latNum, lng: lngNum };
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  };

  for (const ms of [2500, 3500, 4500]) {
    const result = await tryOnce(ms);
    if (result) return result;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

function maybeDebug(obj) {
  return process.env.DEBUG === "1" ? obj : { rates: obj.rates || [] };
}

function maybePayload(p) {
  // avoid echoing full payload in non-debug mode
  return process.env.DEBUG === "1" ? p : undefined;
}

async function safeText(resp) {
  if (!resp) return "";
  try { return await resp.text(); } catch { return ""; }
}
