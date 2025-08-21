export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  // Auth without query params:
  // - Prefer header:   X-Callback-Token: <secret>
  // - Or body:         { "callback_token": "<secret>" }
  const providedToken =
    req.headers["x-callback-token"] ||
    (req.body && req.body.callback_token) ||
    null;

  if (process.env.RATE_CALLBACK_TOKEN && providedToken !== process.env.RATE_CALLBACK_TOKEN) {
    // If you want no auth at all, simply do not define RATE_CALLBACK_TOKEN in Vercel
    return res.status(401).json({ rates: [] });
  }

  try {
    const body = req.body || {};
    const rate = body.rate || {}; // Shopify payload (origin, destination, items, currency)

    // Inputs from body (preferred) with env fallbacks
    const gogetEndpoint =
      (body.goget && body.goget.endpoint) || process.env.GOGET_API_ENDPOINT;

    // Authorization preference: full header -> token -> env token
    const authorizationHeader =
      (body.goget && body.goget.authorization) ||
      (body.goget && body.goget.token ? `Token token=${body.goget.token}` : null) ||
      (process.env.GOGET_API_TOKEN ? `Token token=${process.env.GOGET_API_TOKEN}` : null);

    // Pickup inputs
    const pickupInput = body.pickup || {};
    const pickupName =
      pickupInput.name || process.env.DEFAULT_PICKUP_NAME || "Shop Origin";
    const pickupAddress =
      pickupInput.location ||
      [
        rate.origin?.address1,
        rate.origin?.address2,
        rate.origin?.city,
        rate.origin?.province,
        rate.origin?.zip,
        rate.origin?.country,
      ]
        .filter(Boolean)
        .join(", ");
    const pickupLat = numberOrNull(pickupInput.lat);
    const pickupLng = numberOrNull(pickupInput.lng);

    // Dropoff inputs
    const dropoffInput = body.dropoff || {};
    const dropoffAddress =
      dropoffInput.location ||
      [
        rate.destination?.address1,
        rate.destination?.address2,
        rate.destination?.city,
        rate.destination?.province,
        rate.destination?.zip,
        rate.destination?.country,
      ]
        .filter(Boolean)
        .join(", ");
    const dropoffLat = numberOrNull(dropoffInput.lat);
    const dropoffLng = numberOrNull(dropoffInput.lng);

    // Time
    const startAt =
      pickupInput.start_at ||
      new Date().toISOString(); // pass ISO string in body.pickup.start_at to override

    // Required fields
    if (!gogetEndpoint || !authorizationHeader) return res.json({ rates: [] });
    if (!pickupAddress || !dropoffAddress) return res.json({ rates: [] });

    // Country bias for geocoding
    const countryBias =
      (rate.destination?.country || rate.origin?.country || "").toLowerCase();

    // Geocode if lat/lng not provided
    const [pickupGeo, dropoffGeo] = await resolveCoordinates({
      pickupAddress,
      pickupLat,
      pickupLng,
      dropoffAddress,
      dropoffLat,
      dropoffLng,
      countryBias,
    });
    if (!pickupGeo || !dropoffGeo) return res.json({ rates: [] });

    // Build GoGet payload
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

    if (!ggResp || !ggResp.ok) return res.json({ rates: [] });
    const quote = await ggResp.json();

    // Common response shapes
    const fee =
      numberOrNull(quote?.data?.fee) ??
      numberOrNull(quote?.total_fee) ??
      numberOrNull(quote?.fee);
    if (!Number.isFinite(fee)) return res.json({ rates: [] });

    const priceMinor = Math.round(fee * 100);
    return res.json({
      rates: [
        {
          service_name: "GoGet Delivery",
          service_code: "GOGET_NOW",
          total_price: String(priceMinor),
          currency: rate.currency || "MYR",
        },
      ],
    });
  } catch {
    return res.json({ rates: [] });
  }
}

function numberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function resolveCoordinates({
  pickupAddress,
  pickupLat,
  pickupLng,
  dropoffAddress,
  dropoffLat,
  dropoffLng,
  countryBias,
}) {
  const pickupGeo =
    (Number.isFinite(pickupLat) && Number.isFinite(pickupLng))
      ? { lat: pickupLat, lng: pickupLng }
      : await geocodeAddress(pickupAddress, countryBias);

  if (!pickupGeo) return [null, null];

  const dropoffGeo =
    (Number.isFinite(dropoffLat) && Number.isFinite(dropoffLng))
      ? { lat: dropoffLat, lng: dropoffLng }
      : await geocodeAddress(dropoffAddress, countryBias, pickupGeo);

  return [pickupGeo, dropoffGeo];
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
