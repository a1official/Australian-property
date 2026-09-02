import { crawlGmailViaRemotePlaywright, type RemotePlaywrightConfig } from "@/lib/remote-playwright";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    let options: RemotePlaywrightConfig = {};
    try {
      options = (await request.json()) as RemotePlaywrightConfig;
    } catch {
      // Empty body is allowed
    }

    const result = await crawlGmailViaRemotePlaywright(options);

    return Response.json({
      success: true,
      endpoint: result.endpoint,
      foundThreads: result.foundThreads,
      crawledItems: result.items.length,
      items: result.items,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Remote Playwright crawl failed.";
    console.error("[api/gmail/playwright-crawl] Error:", message);
    return Response.json(
      {
        success: false,
        detail: message,
      },
      { status: 400 }
    );
  }
}

export async function GET() {
  return Response.json({
    description: "Remote Playwright Gmail Crawler Endpoint",
    usage: "Send POST with optional JSON { query, maxEmails, force, wsEndpoint } to trigger remote browser crawl.",
  });
}
