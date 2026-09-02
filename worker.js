// The MailerLite group your early-access signups go into (see
// handleSubscribe below) — the subscriber counter reports the active
// count for this same group.
const EARLY_ACCESS_GROUP_ID = "195826263111239343";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // MailerLite subscription endpoint
    if (url.pathname === "/api/subscribe" && request.method === "POST") {
      return handleSubscribe(request, env);
    }
    // Live subscriber count for the early-access counter
    if (url.pathname === "/api/subscriber-count" && request.method === "GET") {
      return handleSubscriberCount(request, env, ctx);
    }
    // Everything else is served by your existing website
    return env.ASSETS.fetch(request);
  }
};

async function handleSubscribe(request, env) {
  try {
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return jsonResponse(
        { success: false, error: "Invalid request format." },
        400
      );
    }
    const body = await request.json();
    const email = typeof body.email === "string"
      ? body.email.trim()
      : "";
    if (!email) {
      return jsonResponse(
        { success: false, error: "Please enter your email address." },
        400
      );
    }
    // Basic email validation
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailPattern.test(email)) {
      return jsonResponse(
        { success: false, error: "Please enter a valid email address." },
        400
      );
    }
    // MailerLite API
    const response = await fetch("https://connect.mailerlite.com/api/subscribers", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.MAILERLITE_API_TOKEN}`
      },
      body: JSON.stringify({
        email: email,
        groups: [EARLY_ACCESS_GROUP_ID]
      })
    });
    const result = await response.json();
if (!response.ok) {
  console.error("MailerLite API error:", response.status, result);
  return jsonResponse(
    {
      success: false,
      error: "MailerLite API request failed.",
      status: response.status,
      details: result
    },
    500
  );
}
    return jsonResponse({
      success: true,
      message: "You're on the list!"
    });
  } catch (error) {
    console.error("Subscription error:", error);
    return jsonResponse(
      {
        success: false,
        error: "Something went wrong. Please try again."
      },
      500
    );
  }
}

async function handleSubscriberCount(request, env, ctx) {
  // Cache the result for 10 minutes so the counter doesn't hit MailerLite
  // on every page load.
  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).origin + "/api/subscriber-count", {
    method: "GET"
  });

  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    // The groups endpoint returns active_count per group directly, which
    // is a cheaper and more accurate signal than "all subscribers on the
    // account" — this account may end up with other lists later.
    const response = await fetch("https://connect.mailerlite.com/api/groups?limit=100", {
      headers: {
        "Authorization": `Bearer ${env.MAILERLITE_API_TOKEN}`,
        "Accept": "application/json"
      }
    });

    if (!response.ok) {
      const details = await response.json().catch(() => null);
      console.error("MailerLite groups API error:", response.status, details);
      return jsonResponse(
        { error: "MailerLite API request failed.", status: response.status },
        502
      );
    }

    const result = await response.json();
    const group = (result.data || []).find(
      (g) => g.id === EARLY_ACCESS_GROUP_ID
    );
    const count = group ? group.active_count : 0;

    const responseBody = jsonResponse({ count }, 200, {
      "Cache-Control": "public, max-age=600"
    });

    ctx.waitUntil(cache.put(cacheKey, responseBody.clone()));
    return responseBody;
  } catch (error) {
    console.error("Subscriber count error:", error);
    return jsonResponse(
      { error: "Something went wrong fetching the subscriber count." },
      500
    );
  }
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...extraHeaders
    }
  });
}
