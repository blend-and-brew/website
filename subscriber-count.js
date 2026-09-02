// Cloudflare Pages Function — GET /api/subscriber-count
//
// Place this file at: functions/api/subscriber-count.js
// (same folder level as wherever your existing functions/api/subscribe.js lives)
//
// Returns: { "count": <number of active MailerLite subscribers> }
//
// Requires an environment variable / secret named MAILERLITE_API_KEY,
// set in Cloudflare Pages → your project → Settings → Environment variables.
// This must be a MailerLite API token from Integrations > API in your
// MailerLite account (not the classic API key) — it never reaches the browser.

export async function onRequestGet(context) {
    const { env, request } = context;
    const apiKey = env.MAILERLITE_API_KEY;

    if (!apiKey) {
        return new Response(
            JSON.stringify({ error: 'Server is missing MAILERLITE_API_KEY' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }

    // Cache the result for 10 minutes so repeat visits (and the count-up
    // re-running on refresh) don't hit MailerLite's API every time.
    const cache = caches.default;
    const cacheKey = new Request(
        `${new URL(request.url).origin}/api/subscriber-count`,
        { method: 'GET' }
    );

    const cached = await cache.match(cacheKey);
    if (cached) {
        return cached;
    }

    try {
        const mlResponse = await fetch(
            'https://connect.mailerlite.com/api/subscribers?filter[status]=active&limit=0',
            {
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    Accept: 'application/json'
                }
            }
        );

        if (!mlResponse.ok) {
            throw new Error(`MailerLite responded ${mlResponse.status}`);
        }

        const data = await mlResponse.json();
        const count = typeof data.total === 'number' ? data.total : 0;

        const result = new Response(JSON.stringify({ count }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'public, max-age=600'
            }
        });

        context.waitUntil(cache.put(cacheKey, result.clone()));
        return result;
    } catch (error) {
        return new Response(
            JSON.stringify({ error: 'Failed to fetch subscriber count' }),
            { status: 502, headers: { 'Content-Type': 'application/json' } }
        );
    }
}
