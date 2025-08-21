export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  // Shared secret to prevent random calls
  if (req.query.token !== process.env.RATE_CALLBACK_TOKEN) {
    return res.status(401).json({ rates: [] });
  }

  try {
    const { rate } = req.body || {};
    if (!rate) return res.json({ rates: [] });

    // Inputs (prefer query overrides for testing; use env in production)
    const gogetEndpoint =
      req.query.endpoint || process.env.GOGET_API_ENDPOINT;
    const gogetTokenFromQuery = req.query.gg_token;
    const gogetAuthHeaderOverride = req.query.gg_auth; // if you want to pass the full Authorization header
    const gogetTokenEnv = process.env.GOGET_API_TOKEN;

    const pickupName =
      req.query.pickup_name || process.env.DEFAULT_PICKUP_NAME || "Shop Origin";

    // If you pass an explicit pickup address, we’ll geocode it.
    // Otherwise we fall back to Shopify origin address string.
    const pickupAddressOverride = req.query.pickup_location;
    const pickupAddress =
      pickupAddressOverride ||
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

    // Dropoff: use explicit override if provided, else Shopify destination address
    const dropoffAddressOverride = req.query.dropoff_location;
    const dropoffAddress =
      dropoffAddressOverride ||
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

    // start_at: ISO string, otherwise now
    const startAt =
      req.query.start_at ||
      new Date().toISOString(); // pass an ISO like 2023-10-02T10:00:00+08:00 if you need a specific time

    if (!gogetEndpoint) return res.json({ rates: [] });
    const authorizationHeader =
      gogetAuthHeaderOverride ||
      (gogetTokenFromQuery
        ? `Token token=${gogetTokenFromQuery}`
        : gogetTokenEnv
        ? `Token token=${gogetTokenEnv}`
        : null);

    if (!authorizationHeader) return res.json({ rates: [] });
    if (!pickupAddress || !dropoffAddress) return res.json({ rates: [] });

    // Country bias for geocoding
    const countryBias =
      (rate.destination?.country || rate.origin?.country || "").toLowerCase();

    // Geocode both pickup and dropoff via OpenStreetMap
    const [pickupGeo, dropoffGeo] = await Promise.all([
      geocodeAddress(pickupAddress, countryBias),
      geocodeAddress(dropoffAddress, countryBias),
    ]);

    if (!pickupGeo || !dropoffGeo) {
      return res.json({ rates: [] });
    }

    // Build GoGet payload exactly as required
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

    // Try common shapes: {data:{fee}}, {fee}, {total_fee}
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

async function geocodeAddress(address, countryCodeLower) {
  if (!address) return null;
  const params = new URLSearchParams({
    format: "jsonv2",
    q: address,
    limit: "1",
    addressdetails: "0",
  });
  if (countryCodeLower) params.set("countrycodes", countryCodeLower);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/search?${params.toString()}`,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": `goget-carrier/1.0 (${process.env.NOMINATIM_EMAIL || "email@example.com"})`,
        },
        signal: controller.signal,
      }
    );
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
    clearTimeout(timeout);
  }
}
