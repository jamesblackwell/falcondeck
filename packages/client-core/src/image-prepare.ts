import { MAX_IMAGE_ATTACHMENT_BYTES } from "./snapshot";

/**
 * Longest edge sent to vision models. Claude's native cap is 1568px
 * (2576px on 4.7); OpenAI's first resize box is 2048px. Extra pixels are
 * discarded by the provider and only inflate FalconDeck's inline payload.
 */
export const IMAGE_VISION_MAX_LONG_EDGE = 2048;

/** Refuse to decode source files larger than this. ChatGPT's per-image
 * upload cap is 20 MB; 32 MB covers 5K PNG screenshots before JPEG rewrite. */
export const MAX_IMAGE_SOURCE_BYTES = 32_000_000;

/**
 * Re-encode attachments above this size even when they still fit the 10 MB
 * per-image cap. macOS webpage screenshots are typically 2–8 MB PNGs; leaving
 * those intact means a second paste hits the 15 MB turn budget.
 */
export const IMAGE_PREPARE_SOFT_BYTES = 1_000_000;

const JPEG_QUALITIES = [0.82, 0.72, 0.6] as const;
const SECOND_PASS_LONG_EDGE = 1568;
const LAST_PASS_LONG_EDGE = 1280;

const PROVIDER_SAFE_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
]);

type RasterSource = CanvasImageSource;

export function scaledImageSize(
  width: number,
  height: number,
  maxLongEdge: number,
): { width: number; height: number } {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isFinite(maxLongEdge) ||
    width <= 0 ||
    height <= 0 ||
    maxLongEdge <= 0
  ) {
    return { width: 0, height: 0 };
  }
  const longEdge = Math.max(width, height);
  if (longEdge <= maxLongEdge) {
    return { width: Math.round(width), height: Math.round(height) };
  }
  const scale = maxLongEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function jpegAttachmentName(name: string): string {
  const trimmed = name.trim();
  const stem = trimmed.replace(/\.[^.]+$/, "");
  return `${stem || "image"}.jpg`;
}

export function imageNeedsPrepare(file: File, maxBytes: number): boolean {
  if (file.size > maxBytes) return true;
  if (file.size > IMAGE_PREPARE_SOFT_BYTES) return true;
  const type = (file.type ?? "").trim().toLowerCase();
  return type.length > 0 && !PROVIDER_SAFE_IMAGE_TYPES.has(type);
}

/**
 * Downscale and JPEG-encode an attachment so it fits `maxBytes`.
 *
 * Images already under the cap in a provider-safe format are returned as-is.
 * Oversize PNGs (typical Retina screenshots) and HEIC/AVIF sources become
 * JPEGs at a vision-useful size instead of failing the wire budget.
 */
export async function prepareImageFile(
  file: File,
  maxBytes: number,
): Promise<File> {
  const name = file.name.trim() || "Image";
  if (file.size > MAX_IMAGE_SOURCE_BYTES) {
    throw new Error(
      `${name} is too large to prepare. Source images must be 32 MB or smaller.`,
    );
  }
  const cap = Math.max(0, maxBytes);
  if (cap <= 0) {
    throw new Error(
      "Those images are too large together. Attach no more than 15 MB at once.",
    );
  }
  if (!imageNeedsPrepare(file, cap)) {
    return file;
  }
  if (!canRasterizeImage()) {
    throw attachmentPrepareError(name, file.size, cap);
  }
  try {
    const prepared = await rasterizeToJpeg(file, cap);
    if (prepared.size <= cap) {
      // Re-encoding an already-tight JPEG can grow it. Keep the original when
      // it still fits the wire cap.
      if (prepared.size >= file.size && file.size <= cap) return file;
      return prepared;
    }
  } catch {
    throw attachmentPrepareError(name, file.size, cap);
  }
  throw attachmentPrepareError(name, file.size, cap);
}

function attachmentPrepareError(
  name: string,
  bytes: number,
  cap: number,
): Error {
  if (bytes <= cap) {
    return new Error(
      `${name} could not be prepared. Try a JPEG or PNG.`,
    );
  }
  if (cap < MAX_IMAGE_ATTACHMENT_BYTES) {
    return new Error(
      "Those images are too large together. Attach no more than 15 MB at once.",
    );
  }
  return new Error(
    `${name} is too large. Images must be 10 MB or smaller.`,
  );
}

function canRasterizeImage(): boolean {
  if (typeof document === "undefined") return false;
  if (typeof document.createElement !== "function") return false;
  return (
    typeof createImageBitmap === "function" || typeof Image !== "undefined"
  );
}

async function rasterizeToJpeg(file: File, maxBytes: number): Promise<File> {
  const decoded = await decodeImageFile(file);
  try {
    if (decoded.width <= 0 || decoded.height <= 0) {
      throw new Error("decode");
    }
    const edges = [
      IMAGE_VISION_MAX_LONG_EDGE,
      SECOND_PASS_LONG_EDGE,
      LAST_PASS_LONG_EDGE,
    ];
    let smallest: File | null = null;
    for (const edge of edges) {
      const { width, height } = scaledImageSize(
        decoded.width,
        decoded.height,
        edge,
      );
      for (const quality of JPEG_QUALITIES) {
        const blob = await drawJpeg(decoded.source, width, height, quality);
        const next = new File(
          [blob],
          jpegAttachmentName(file.name || "image.jpg"),
          {
            type: "image/jpeg",
            lastModified: file.lastModified,
          },
        );
        if (!smallest || next.size < smallest.size) smallest = next;
        if (next.size <= maxBytes) return next;
      }
    }
    if (smallest) return smallest;
    throw new Error("encode");
  } finally {
    decoded.close();
  }
}

async function decodeImageFile(file: File): Promise<{
  source: RasterSource;
  width: number;
  height: number;
  close: () => void;
}> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await decodeWithImageBitmap(file);
    if (bitmap) return bitmap;
  }
  return decodeWithHtmlImage(file);
}

async function decodeWithImageBitmap(file: File): Promise<{
  source: RasterSource;
  width: number;
  height: number;
  close: () => void;
} | null> {
  const optionSets: ImageBitmapOptions[] = [
    // Honor EXIF orientation from phone photos. Older WebKits throw on the
    // unknown key and we retry without it.
    { imageOrientation: "from-image" } as ImageBitmapOptions,
    {},
  ];
  for (const options of optionSets) {
    try {
      const bitmap = await createImageBitmap(file, options);
      if (bitmap.width > 0 && bitmap.height > 0) {
        return {
          source: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          close: () => bitmap.close(),
        };
      }
      bitmap.close();
    } catch {
      // try the next option set or HTMLImageElement
    }
  }
  return null;
}

function decodeWithHtmlImage(file: File): Promise<{
  source: RasterSource;
  width: number;
  height: number;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    let settled = false;
    const close = () => {
      URL.revokeObjectURL(url);
      image.onload = null;
      image.onerror = null;
      image.src = "";
    };
    image.onload = () => {
      if (settled) return;
      settled = true;
      resolve({
        source: image,
        width: image.naturalWidth || image.width,
        height: image.naturalHeight || image.height,
        close,
      });
    };
    image.onerror = () => {
      if (settled) return;
      settled = true;
      close();
      reject(new Error("decode"));
    };
    image.src = url;
  });
}

async function drawJpeg(
  source: RasterSource,
  width: number,
  height: number,
  quality: number,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);
  return canvasToJpegBlob(canvas, quality);
}

async function canvasToJpegBlob(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob> {
  if (typeof canvas.toBlob === "function") {
    const blob = await new Promise<Blob | null>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (result: Blob | null) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve(result);
      };
      timer = setTimeout(() => done(null), 250);
      try {
        canvas.toBlob((result) => done(result), "image/jpeg", quality);
      } catch {
        done(null);
      }
    });
    if (blob && blob.size > 0) return blob;
  }
  // WKWebView has historically returned null from toBlob for JPEG. toDataURL
  // is the reliable encode path for a 2048px screenshot.
  if (typeof canvas.toDataURL === "function") {
    return jpegDataUrlToBlob(canvas.toDataURL("image/jpeg", quality));
  }
  throw new Error("encode");
}

function jpegDataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(",");
  const header = comma >= 0 ? dataUrl.slice(0, comma) : "";
  const payload = comma >= 0 ? dataUrl.slice(comma + 1).replace(/\s/g, "") : "";
  if (!/data:image\/jpeg/i.test(header) || !payload) {
    throw new Error("encode");
  }
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: "image/jpeg" });
}
