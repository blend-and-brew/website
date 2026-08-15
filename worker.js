export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // MailerLite subscription endpoint
    if (url.pathname === "/api/subscribe" && request.method === "POST") {
      return handleSubscribe(request, env);
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
        groups: ["195826263111239343"]
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

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}
