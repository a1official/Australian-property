const ALLOWED_HOSTS = new Set(["images.corelogic.asia", "images-uat.corelogic.asia"]);
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

export async function GET(request: Request) {
  const source = new URL(request.url).searchParams.get("src");
  if (!source) return Response.json({ detail: "Missing image source." }, { status: 400 });

  let imageUrl: URL;
  try {
    imageUrl = new URL(source);
  } catch {
    return Response.json({ detail: "Invalid image source." }, { status: 400 });
  }

  if (imageUrl.protocol !== "https:" || !ALLOWED_HOSTS.has(imageUrl.hostname)) {
    return Response.json({ detail: "Image host is not allowed." }, { status: 400 });
  }

  try {
    const response = await fetch(imageUrl, {
      headers: { Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8" },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const contentType = response.headers.get("content-type") || "";
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (!response.ok || !contentType.startsWith("image/") || contentLength > MAX_IMAGE_BYTES) {
      return Response.json({ detail: "Cotality image could not be retrieved." }, { status: 502 });
    }

    const image = await response.arrayBuffer();
    if (image.byteLength > MAX_IMAGE_BYTES) {
      return Response.json({ detail: "Cotality image is too large to embed." }, { status: 413 });
    }
    return new Response(image, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch {
    return Response.json({ detail: "Cotality image could not be retrieved." }, { status: 502 });
  }
}
