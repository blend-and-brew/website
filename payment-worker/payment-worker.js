/**
 * Blend & Brew — Payment Worker
 * ------------------------------------------------------------
 * Receives a tokenized card (sourceId) from payment.html, charges it
 * via Square's Payments API, and returns { success, receiptId } (or
 * { success:false, error }) back to the page.
 *
 * Route: blendandbrew.com.au/payment
 *
 * SECRET SETUP (run once from your terminal, in the folder with this
 * file's wrangler.jsonc — never paste the token into chat or code):
 *
 *   wrangler secret put SQUARE_ACCESS_TOKEN
 *
 * It will prompt you to paste the token — get it from:
 * Square Developer Dashboard → your app → Sandbox tab → "Sandbox Access Token"
 *
 * When you're ready to go live, you'll need a SEPARATE production
 * Access Token from the "Production" tab, plus swapping:
 *   - the Square SDK script in payment.html to the production URL
 *   - SQUARE_ENV below to 'production'
 *   - SQUARE_APPLICATION_ID / SQUARE_LOCATION_ID in payment.html to
 *     your production app's values
 * ------------------------------------------------------------
 */

// Set to 'sandbox' while testing, 'production' when you go live.
const SQUARE_ENV = 'sandbox';

const SQUARE_API_BASE = SQUARE_ENV === 'production'
  ? 'https://connect.squareup.com'
  : 'https://connect.squareupsandbox.com';

// Must match the Location ID hardcoded in payment.html for this environment.
const SQUARE_LOCATION_ID = 'L7FM3WCWEHZCE';

// Allowed origins for CORS — add any other domains this form is served from.
const ALLOWED_ORIGINS = [
  'https://www.blendandbrew.com.au',
  'https://blendandbrew.com.au',
];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    // Only handle the /payment route
    if (url.pathname !== '/payment') {
      return jsonResponse({ success: false, error: 'Not found' }, 404, origin);
    }

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== 'POST') {
      return jsonResponse({ success: false, error: 'Method not allowed' }, 405, origin);
    }

    if (!env.SQUARE_ACCESS_TOKEN) {
      console.error('Missing SQUARE_ACCESS_TOKEN secret');
      return jsonResponse({ success: false, error: 'Payment processor is not configured. Please contact us directly.' }, 500, origin);
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse({ success: false, error: 'Invalid request body.' }, 400, origin);
    }

    const { sourceId, amount, currency, reference, cardholderName, note } = payload || {};

    // ---- Basic validation ----
    if (!sourceId || typeof sourceId !== 'string') {
      return jsonResponse({ success: false, error: 'Missing card token.' }, 400, origin);
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      return jsonResponse({ success: false, error: 'Invalid payment amount.' }, 400, origin);
    }
    if (currency !== 'AUD') {
      return jsonResponse({ success: false, error: 'Unsupported currency.' }, 400, origin);
    }

    // ---- Charge the card via Square Payments API ----
    const idempotencyKey = crypto.randomUUID();

    try {
      const squareRes = await fetch(`${SQUARE_API_BASE}/v2/payments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
          'Square-Version': '2024-10-17',
        },
        body: JSON.stringify({
          idempotency_key: idempotencyKey,
          source_id: sourceId,
          amount_money: {
            amount: amount, // cents
            currency: 'AUD',
          },
          location_id: SQUARE_LOCATION_ID,
          reference_id: (reference || '').slice(0, 40) || undefined,
          note: [cardholderName, note].filter(Boolean).join(' — ').slice(0, 500) || undefined,
        }),
      });

      const squareData = await squareRes.json().catch(() => ({}));

      if (!squareRes.ok) {
        const detail = (squareData.errors && squareData.errors[0] && squareData.errors[0].detail)
          || 'The payment could not be processed. Please check your card details and try again.';
        console.error('Square API error:', JSON.stringify(squareData));
        return jsonResponse({ success: false, error: detail }, 402, origin);
      }

      const payment = squareData.payment || {};

      return jsonResponse({
        success: true,
        paymentId: payment.id,
        receiptId: payment.receipt_number || payment.id,
        receiptUrl: payment.receipt_url || null,
        status: payment.status,
      }, 200, origin);

    } catch (err) {
      console.error('Payment worker error:', err);
      return jsonResponse({ success: false, error: 'Something went wrong processing your payment. Please try again shortly.' }, 500, origin);
    }
  },
};
