import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_IMAGE_ATTACHMENT_BYTES } from "./snapshot";
import {
  IMAGE_PREPARE_SOFT_BYTES,
  IMAGE_VISION_MAX_LONG_EDGE,
  MAX_IMAGE_SOURCE_BYTES,
  imageNeedsPrepare,
  jpegAttachmentName,
  prepareImageFile,
  scaledImageSize,
} from "./image-prepare";

function oversizedPng(name: string, bytes: number) {
  const file = new File(["not-a-real-png"], name, { type: "image/png" });
  Object.defineProperty(file, "size", { value: bytes });
  return file;
}

function stubJpegRasterizer(options?: {
  toBlob?: (callback: (blob: Blob | null) => void) => void;
  toDataURL?: () => string;
}) {
  const close = vi.fn();
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({
      width: 4096,
      height: 2304,
      close,
    })),
  );
  const drawImage = vi.fn();
  const toBlob =
    options?.toBlob ??
    ((callback: (blob: Blob | null) => void) => {
      callback(new Blob([new Uint8Array(12_000)], { type: "image/jpeg" }));
    });
  vi.stubGlobal("document", {
    createElement: (tag: string) => {
      expect(tag).toBe("canvas");
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          imageSmoothingEnabled: false,
          imageSmoothingQuality: "low",
          fillStyle: "",
          fillRect: vi.fn(),
          drawImage,
        }),
        toBlob,
        toDataURL: options?.toDataURL,
      };
    },
  });
  return { close, drawImage };
}

describe("scaledImageSize", () => {
  it("keeps images already within the long-edge cap", () => {
    expect(scaledImageSize(1280, 720, IMAGE_VISION_MAX_LONG_EDGE)).toEqual({
      width: 1280,
      height: 720,
    });
  });

  it("shrinks the long edge and preserves aspect ratio", () => {
    expect(scaledImageSize(4096, 2304, IMAGE_VISION_MAX_LONG_EDGE)).toEqual({
      width: 2048,
      height: 1152,
    });
  });

  it("handles portrait and invalid input", () => {
    expect(scaledImageSize(1080, 3240, 2048)).toEqual({
      width: 683,
      height: 2048,
    });
    expect(scaledImageSize(0, 100, 2048)).toEqual({ width: 0, height: 0 });
  });
});

describe("jpegAttachmentName", () => {
  it("replaces the last extension and fills in a missing stem", () => {
    expect(jpegAttachmentName("image.png")).toBe("image.jpg");
    expect(jpegAttachmentName("my.photo.PNG")).toBe("my.photo.jpg");
    expect(jpegAttachmentName("screenshot")).toBe("screenshot.jpg");
    expect(jpegAttachmentName("   ")).toBe("image.jpg");
  });
});

describe("imageNeedsPrepare", () => {
  it("prepares oversize files, screenshot-sized PNGs, and provider-unsafe types", () => {
    expect(
      imageNeedsPrepare(
        oversizedPng("shot.png", MAX_IMAGE_ATTACHMENT_BYTES + 1),
        MAX_IMAGE_ATTACHMENT_BYTES,
      ),
    ).toBe(true);

    expect(
      imageNeedsPrepare(
        oversizedPng("webpage.png", IMAGE_PREPARE_SOFT_BYTES + 1),
        MAX_IMAGE_ATTACHMENT_BYTES,
      ),
    ).toBe(true);

    const smallPng = new File(["abc"], "shot.png", { type: "image/png" });
    expect(imageNeedsPrepare(smallPng, MAX_IMAGE_ATTACHMENT_BYTES)).toBe(false);

    const heic = new File(["abc"], "photo.heic", { type: "image/heic" });
    expect(imageNeedsPrepare(heic, MAX_IMAGE_ATTACHMENT_BYTES)).toBe(true);

    // Browsers may leave File.type empty when the OS has no MIME mapping.
    // The attachment must be rasterized into a provider-safe format rather
    // than sent with an unusable empty media type.
    const untypedPng = new File(["abc"], "photo.png");
    expect(imageNeedsPrepare(untypedPng, MAX_IMAGE_ATTACHMENT_BYTES)).toBe(true);
  });
});

describe("prepareImageFile", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns a fitting provider-safe file unchanged", async () => {
    const file = new File(["abc"], "shot.png", { type: "image/png" });
    await expect(prepareImageFile(file, MAX_IMAGE_ATTACHMENT_BYTES)).resolves.toBe(
      file,
    );
  });

  it("refuses to decode a source file above the sanity cap", async () => {
    const file = new File(["abc"], "huge.png", { type: "image/png" });
    Object.defineProperty(file, "size", { value: MAX_IMAGE_SOURCE_BYTES + 1 });
    await expect(prepareImageFile(file, MAX_IMAGE_ATTACHMENT_BYTES)).rejects.toThrow(
      "huge.png is too large to prepare. Source images must be 32 MB or smaller.",
    );
  });

  it("compresses an oversize image to a JPEG that fits the cap", async () => {
    const file = oversizedPng("image.png", MAX_IMAGE_ATTACHMENT_BYTES + 1);
    const { close, drawImage } = stubJpegRasterizer();

    const prepared = await prepareImageFile(file, MAX_IMAGE_ATTACHMENT_BYTES);
    expect(prepared).not.toBe(file);
    expect(prepared.type).toBe("image/jpeg");
    expect(prepared.name).toBe("image.jpg");
    expect(prepared.size).toBe(12_000);
    expect(prepared.size).toBeLessThan(MAX_IMAGE_ATTACHMENT_BYTES);
    expect(drawImage).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it("compresses a screenshot-sized PNG that is still under the 10 MB cap", async () => {
    const file = oversizedPng("image.png", IMAGE_PREPARE_SOFT_BYTES + 50_000);
    stubJpegRasterizer();

    const prepared = await prepareImageFile(file, MAX_IMAGE_ATTACHMENT_BYTES);
    expect(prepared.type).toBe("image/jpeg");
    expect(prepared.size).toBe(12_000);
  });

  it("falls back to toDataURL when WKWebView toBlob returns nothing", async () => {
    const file = oversizedPng("image.png", MAX_IMAGE_ATTACHMENT_BYTES + 1);
    stubJpegRasterizer({
      toBlob: (callback) => callback(null),
      toDataURL: () => "data:image/jpeg;base64,QQ==",
    });

    const prepared = await prepareImageFile(file, MAX_IMAGE_ATTACHMENT_BYTES);
    expect(prepared.type).toBe("image/jpeg");
    expect(prepared.size).toBeGreaterThan(0);
    expect(prepared.size).toBeLessThan(MAX_IMAGE_ATTACHMENT_BYTES);
  });
});
