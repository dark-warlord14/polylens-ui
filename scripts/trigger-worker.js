/**
 * Cloudflare Worker Blueprint (Proxy to GitHub)
 * 
 * Deployment: Use 'wrangler' to deploy this to your Cloudflare account.
 * This worker acts as a secure bridge to trigger your GitHub Action.
 */

export default {
  async fetch(request, env) {
    // Only allow POST requests for syncing
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // AUTH_TOKEN is a secret you set in Cloudflare dashboard
    // GITHUB_PAT is your GitHub Personal Access Token
    const GITHUB_OWNER = "YOUR_USERNAME";
    const GITHUB_REPO = "polylens-ui";

    try {
      const response = await fetch(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/dispatches`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.GITHUB_PAT}`,
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "Polylens-Sync-Worker",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ event_type: "webhook_sync" }),
        }
      );

      if (response.ok) {
        return new Response(JSON.stringify({ status: "Sync Triggered" }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      } else {
        const err = await response.text();
        return new Response(`GitHub Error: ${err}`, { status: response.status });
      }
    } catch (e) {
      return new Response(`Worker Error: ${e.message}`, { status: 500 });
    }
  },
};
