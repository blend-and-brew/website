/**
 * Blend & Brew — Payment Worker
 * Routes (all under www.blendandbrew.com.au/api/pay):
 *   POST /create  (COGS, needs X-Admin-Key)  -> saves a quote as an order, returns { success, id }
 *   GET  /order   (payment.html, public)     -> returns the order + public Square config
 *   POST /charge  (payment.html, public)     -> charges the card for the order's saved amount
 *
 * Needs: KV binding ORDERS, secrets SQUARE_ACCESS_TOKEN + ADMIN_KEY,
 *        vars SQUARE_ENV, SQUARE_LOCATION_ID, SQUARE_APPLICATION_ID (see wrangler.jsonc)
 */

const ALLOWED_ORIGINS = [
  'https://www.blendandbrew.com.au',
  'https://blendandbrew.com.au',
  'https://cogs.blendandbrew.com.au',
];

function cors(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
    'Vary': 'Origin',
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });
}

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.byteLength !== y.byteLength) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const orderKey = (id) => 'order:' + id;
const refKey = (ref) => 'ref:' + ref.toLowerCase();

/* ------------------------------ CREATE ------------------------------ */
async function handleCreate(request, env, origin) {
  const key = request.headers.get('X-Admin-Key') || '';
  if (!env.ADMIN_KEY || !(await safeEqual(key, env.ADMIN_KEY))) {
    return json({ success: false, error: 'Unauthorized' }, 401, origin);
  }

  let p;
  try { p = await request.json(); } catch {
    return json({ success: false, error: 'Invalid request body.' }, 400, origin);
  }

  const amount = p.amountCents;
  if (!Number.isInteger(amount) || amount < 100 || amount > 5000000) {
    return json({ success: false, error: 'Invalid amount.' }, 400, origin);
  }
  const ref = String(p.ref || '').trim().slice(0, 40);
  if (!ref) return json({ success: false, error: 'Missing reference.' }, 400, origin);

  const ids = JSON.parse((await env.ORDERS.get(refKey(ref))) || '[]');
  const existing = (await Promise.all(ids.map((id) => env.ORDERS.get(orderKey(id), 'json')))).filter(Boolean);

  if (!p.force) {
    const paid = existing.find((o) => o.status === 'paid');
    if (paid) {
      return json({
        success: false, code: 'ALREADY_PAID', paidAmount: paid.amount,
        error: 'This booking already has a paid order.',
      }, 409, origin);
    }
    const review = existing.find((o) => o.status === 'review');
    if (review) {
      return json({
        success: false, code: 'NEEDS_REVIEW',
        error: 'An earlier payment attempt for this booking ended unclear. Check the Square dashboard before creating another link.',
      }, 409, origin);
    }
  }

  // Re-use the open (unpaid) order for this booking so regenerating a quote
  // doesn't pile up duplicate links.
  const reuse = p.force ? null : existing.find((o) => o.status === 'unpaid');
  const now = new Date().toISOString();
  const id = reuse ? reuse.id : crypto.randomUUID();

  const order = {
    ...(reuse || {}),
    id,
    ref,
    name: String(p.name || '').slice(0, 120),
    amount,
    date: String(p.date || '').slice(0, 20),
    location: String(p.location || '').slice(0, 300),
    start: String(p.start || '').slice(0, 10),
    end: String(p.end || '').slice(0, 10),
    breakdown: Array.isArray(p.breakdown) ? p.breakdown.slice(0, 60) : [],
    quoteHtml: typeof p.quoteHtml === 'string' ? p.quoteHtml.slice(0, 500000) : '',
    status: 'unpaid',
    createdAt: reuse ? reuse.createdAt : now,
    updatedAt: now,
  };

  await env.ORDERS.put(orderKey(id), JSON.stringify(order));
  if (!reuse) {
    ids.push(id);
    await env.ORDERS.put(refKey(ref), JSON.stringify(ids));
  }
  return json({ success: true, id }, 200, origin);
}

/* ------------------------------ ORDER ------------------------------ */
async function handleOrder(url, env, origin) {
  const id = url.searchParams.get('id') || '';
  const order = id ? await env.ORDERS.get(orderKey(id), 'json') : null;
  if (!order) return json({ success: false, error: 'This payment link is not valid.' }, 404, origin);

  return json({
    success: true,
    order: {
      id: order.id, ref: order.ref, name: order.name, amount: order.amount,
      date: order.date, location: order.location, start: order.start, end: order.end,
      breakdown: order.breakdown, quoteHtml: order.quoteHtml,
      status: order.status === 'paid' ? 'paid' : 'unpaid',
      receiptId: order.receiptId || null,
    },
    square: {
      env: env.SQUARE_ENV === 'production' ? 'production' : 'sandbox',
      applicationId: env.SQUARE_APPLICATION_ID,
      locationId: env.SQUARE_LOCATION_ID,
    },
  }, 200, origin);
}

/* ------------------------------ CHARGE ------------------------------ */
async function handleCharge(request, env, origin) {
  if (!env.SQUARE_ACCESS_TOKEN) {
    console.error('Missing SQUARE_ACCESS_TOKEN secret');
    return json({ success: false, error: 'Payment processor is not configured. Please contact us directly.' }, 500, origin);
  }

  let p;
  try { p = await request.json(); } catch {
    return json({ success: false, error: 'Invalid request body.' }, 400, origin);
  }
  const { orderId, sourceId, cardholderName } = p || {};
  if (!orderId || typeof orderId !== 'string') return json({ success: false, error: 'Missing order.' }, 400, origin);
  if (!sourceId || typeof sourceId !== 'string') return json({ success: false, error: 'Missing card token.' }, 400, origin);

  const order = await env.ORDERS.get(orderKey(orderId), 'json');
  if (!order) return json({ success: false, error: 'This payment link is not valid.' }, 404, origin);
  if (order.status === 'paid') return json({ success: false, error: 'This booking has already been paid.' }, 409, origin);
  if (order.status === 'review') {
    return json({ success: false, error: 'We are checking an earlier payment attempt on this booking. Please contact us before trying again.' }, 409, origin);
  }

  const base = env.SQUARE_ENV === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';
  const idempotencyKey = (await sha256hex(orderId + ':' + sourceId)).slice(0, 45);

  let squareRes;
  try {
    squareRes = await fetch(`${base}/v2/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
        'Square-Version': '2024-10-17',
      },
      body: JSON.stringify({
        idempotency_key: idempotencyKey,
        source_id: sourceId,
        // Amount always comes from the saved order, never from the browser.
        amount_money: { amount: order.amount, currency: 'AUD' },
        location_id: env.SQUARE_LOCATION_ID,
        reference_id: order.ref.slice(0, 40),
        note: [order.ref, cardholderName].filter(Boolean).join(' - ').slice(0, 500),
      }),
    });
  } catch (err) {
    // Couldn't tell whether Square charged the card: freeze the order for manual review.
    console.error('Square network error:', err);
    order.status = 'review';
    await env.ORDERS.put(orderKey(orderId), JSON.stringify(order));
    return json({ success: false, error: 'Something went wrong processing your payment. Please contact us before trying again.' }, 500, origin);
  }

  const data = await squareRes.json().catch(() => ({}));

  if (!squareRes.ok) {
    console.error('Square API error:', JSON.stringify(data));
    if (squareRes.status >= 500) {
      order.status = 'review';
      await env.ORDERS.put(orderKey(orderId), JSON.stringify(order));
    }
    const detail = (data.errors && data.errors[0] && data.errors[0].detail)
      || 'The payment could not be processed. Please check your card details and try again.';
    return json({ success: false, error: detail }, 402, origin);
  }

  const payment = data.payment || {};
  order.status = 'paid';
  order.paymentId = payment.id;
  order.receiptId = payment.receipt_number || payment.id;
  order.receiptUrl = payment.receipt_url || null;
  order.paidAt = new Date().toISOString();
  try {
    await env.ORDERS.put(orderKey(orderId), JSON.stringify(order));
  } catch (err) {
    console.error('Paid in Square but failed to save order', orderId, payment.id, err);
  }

  return json({
    success: true,
    paymentId: payment.id,
    receiptId: order.receiptId,
    receiptUrl: order.receiptUrl,
    status: payment.status,
  }, 200, origin);
}

/* ------------------------------ ROUTER ------------------------------ */
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    const route = url.pathname.replace(/^\/api\/pay/, '').replace(/\/+$/, '');

    try {
      if (route === '/create' && request.method === 'POST') return await handleCreate(request, env, origin);
      if (route === '/order' && request.method === 'GET') return await handleOrder(url, env, origin);
      if (route === '/charge' && request.method === 'POST') return await handleCharge(request, env, origin);
    } catch (err) {
      console.error('Unhandled error:', err);
      return json({ success: false, error: 'Server error. Please try again shortly.' }, 500, origin);
    }

    if (['/create', '/order', '/charge'].includes(route)) {
      return json({ success: false, error: 'Method not allowed' }, 405, origin);
    }
    return json({ success: false, error: 'Not found' }, 404, origin);
  },
};
