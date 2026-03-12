import { initializeImageMagick, ImageMagick, MagickFormat } from "npm:@imagemagick/magick-wasm@0.0.35";
import wasmLocation from "npm:@imagemagick/magick-wasm@0.0.35/magick.wasm?url";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const wasmReady = (async () => {
  const response = await fetch(wasmLocation);
  if (!response.ok) {
    throw new Error(`Failed to load ImageMagick WASM: ${response.status}`);
  }
  initializeImageMagick(new Uint8Array(await response.arrayBuffer()));
})();

function json(status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function stripDataUrlPrefix(value: string): string {
  const raw = String(value || "").trim();
  const match = raw.match(/^data:[^;]+;base64,(.+)$/);
  return match ? match[1] : raw;
}

function decodeBase64(value: string): Uint8Array {
  const clean = stripDataUrlPrefix(value).replace(/\s+/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json(405, { ok: false, message: "Method not allowed." });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch (_err) {
    return json(400, { ok: false, message: "Invalid request body." });
  }

  const imageBase64 = typeof body.imageBase64 === "string" ? body.imageBase64 : "";
  const requestedQuality = Number(body.quality || 82);
  const quality = Number.isFinite(requestedQuality)
    ? Math.max(55, Math.min(90, Math.round(requestedQuality)))
    : 82;
  if (!imageBase64) {
    return json(400, { ok: false, message: "Missing imageBase64." });
  }

  try {
    await wasmReady;
    const inputBytes = decodeBase64(imageBase64);
    let outputBytes: Uint8Array | null = null;

    ImageMagick.read(inputBytes, (image) => {
      image.quality = quality;
      image.format = MagickFormat.Jpeg;
      image.write((data) => {
        outputBytes = data;
      });
    });

    if (!outputBytes || outputBytes.length === 0) {
      return json(502, { ok: false, message: "Image normalization returned no output." });
    }

    return json(200, {
      ok: true,
      mimeType: "image/jpeg",
      normalizedBase64: encodeBase64(outputBytes),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Image normalization failed.";
    return json(500, { ok: false, message });
  }
});
