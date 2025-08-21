// api/rates/goget.js
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  // Simple auth to prevent random calls
  if (req.query.token !== process.env.RATE_CALLBACK_TOKEN) {
    return res.status(401).json({ rates: [] });
  }

  try {
    const { rate } = req.body || {};
    if (!rate) return res.json({ rates: [] });

    // Use store’s configured pickup if provided; fall back to Shopify origin
    const pickup = {
      name: process.env.DEFAULT_PICKUP_NAME || "Shop Origin",
      location: process.env.DEFAULT_PICKUP_ADDRESS || [
        rate.origin?.address1,
        rate.origin?.address2,
        rate.origin?.city,
        rate.origin?.province,
        rate.origin?.zip,
        rate.origin?.country,
      ].filter(Boolean).join(", "),
      location_lat: envNumber(process.env.DEFAULT_PICKUP_LAT),
      location_long: envNumber(process.env.DEFAULT_PICKUP_LNG),
      parking: true,
      start_at: new Date().toISOString(),
    };

    // Geocode dropoff to lat/lng (required by GoGet)
    const drop = await geocodeAddress({
      address: [
        rate.destination?.address1,
        rate.destination?.address2,
        rate.destination?.city,
        rate.destination?.province,
        rate.destination?.zip,
        rate.destination?.country,
      ].filter(Boolean).join(", "),
      country: rate.destination?.country || "",
    });

    if (!drop) return res.json({ rates: [] });

    const gogetPayload = {
      pickup,
      dropoff: [{ location: drop.full, location_lat: drop.lat, location_long: drop.lng }],
      ride_id: 2,
      bulky: false,
      guarantee: true,
      num_of_items: "1-2",
      flexi: false,
      route: false,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    const ggResp = await fetch(process.env.GOGET_API_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Token token=${process.env.GOGET_API_TOKEN}`,
      },
      body: JSON.stringify(gogetPayload),
      signal: controller.signal,
    }).catch(() => null);

    clearTimeout(timeout);
    if (!ggResp || !ggResp.ok) return res.json({ rates: [] });

    const quote = await ggResp.json(); // expected: { data: { fee: number } } or { total_fee: number }
    const fee =
      Number(quote?.data?.fee ?? quote?.total_fee ?? quote?.fee);
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

function envNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

async function geocodeAddress({ address, country }) {
  if (!address) return null;

  const params = new URLSearchParams({
    format: "jsonv2",
    q: address,
    limit: "1",
    addressdetails: "0",
  });
  if (country) params.set("countrycodes", (country || "").toLowerCase());

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": `goget-carrier/1.0 (${process.env.NOMINATIM_EMAIL || "email@example.com"})`,
      },
      signal: controller.signal,
    });
    if (!r.ok) return null;
    const arr = await r.json();
    if (!Array.isArray(arr) || arr.length === 0) return null;

    const { lat, lon, display_name } = arr[0];
    const latNum = Number(lat);
    const lngNum = Number(lon);
    if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) return null;

    return { lat: latNum, lng: lngNum, full: display_name || address };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
