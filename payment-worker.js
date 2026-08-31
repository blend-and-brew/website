/**
 * ============================================================
 * BLEND & BREW — SQUARE PAYMENT WORKER
 * ============================================================
 * Receives the card token (nonce) created client-side by payment.html
 * and uses it to actually charge the card via Square's Payments API.
 * This step MUST happen server-side — Square access tokens are secret
 * and can never be exposed in browser JavaScript.
 *
 * DEPLOY:
 *   Either deploy this as its own Cloudflare Worker (its own route,
 *   e.g. pay.blendandbrew.com.au or blendandbrew.com.au/api/charge),
 *   or merge the `/charge` route below into your existing worker.js
 *   alongside the MailerLite subscribe endpoint.
 *
 * ENVIRONMENT VARIABLES (set these as Worker secrets, never hard-code
 * them in this file):
 *   SQUARE_ACCESS_TOKEN   — from Square Developer Dashboard
 *   SQUARE_LOCATION_ID    — same location ID used in payment.html
 *   SQUARE_ENVIRONMENT    — "sandbox" or "production"
 *
 *   wrangler secret put SQUARE_ACCESS_TOKEN
 *   wrangler secret put SQUARE_LOCATION_ID
 *   wrangler secret put SQUARE_ENVIRONMENT
 * ============================================================
 */

export default {
  async fetch(request, env) {
    // CORS — restrict this to your real domain before going live.
    const corsHeaders = {
      'Access-Control-Allow-Origin': 'https://www.blendandbrew.com.au',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ success: false, error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    let body;
    try {
      body = await request.json();
    } catch (err) {
      return jsonResponse({ success: false, error: 'Invalid request body.' }, 400, corsHeaders);
    }

    const { sourceId, amount, currency, reference, cardholderName, note } = body;

    if (!sourceId || !amount || !Number.isInteger(amount) || amount <= 0) {
      return jsonResponse({ success: false, error: 'Missing or invalid payment details.' }, 400, corsHeaders);
    }

    const squareBase = env.SQUARE_ENVIRONMENT === 'production'
      ? 'https://connect.squareup.com'
      : 'https://connect.squareupsandbox.com';

    // Idempotency key stops the same submission being charged twice
    // (e.g. if the customer double-clicks, or the response is dropped
    // and the browser retries).
    const idempotencyKey = crypto.randomUUID();

    const squarePayload = {
      source_id: sourceId,
      idempotency_key: idempotencyKey,
      amount_money: {
        amount: amount, // in cents
        currency: currency || 'AUD',
      },
      location_id: env.SQUARE_LOCATION_ID,
      note: [reference, note].filter(Boolean).join(' — ').slice(0, 500),
      buyer_email_address: body.email || undefined,
    };

    try {
      const squareRes = await fetch(`${squareBase}/v2/payments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
          'Square-Version': '2024-08-21',
        },
        body: JSON.stringify(squarePayload),
      });

      const squareData = await squareRes.json();

      if (!squareRes.ok || !squareData.payment) {
        const detail = (squareData.errors && squareData.errors[0] && squareData.errors[0].detail)
          || 'Payment was declined or could not be processed.';
        console.error('Square API error:', squareData);
        return jsonResponse({ success: false, error: detail }, 402, corsHeaders);
      }

      return jsonResponse({
        success: true,
        paymentId: squareData.payment.id,
        receiptId: squareData.payment.receipt_number || squareData.payment.id,
        receiptUrl: squareData.payment.receipt_url || null,
        status: squareData.payment.status,
      }, 200, corsHeaders);

    } catch (err) {
      console.error('Worker error calling Square:', err);
      return jsonResponse({ success: false, error: 'Could not reach the payment processor. Please try again.' }, 502, corsHeaders);
    }
  },
};

function jsonResponse(data, status, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}
