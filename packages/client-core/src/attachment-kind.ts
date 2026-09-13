import type { ImageInput } from "./types";

/**
 * Attachments travel on the wire as `ImageInput` regardless of what they hold:
 * the daemon materializes the bytes into the thread's attachment directory and
 * hands agents a local path either way. Only the delivery differs — images are
 * embedded as vision blocks, documents are referenced by path so the agent can
 * open them with its own file tools.
 */
export type AttachmentKind = "image" | "document";

/** Extensions browsers commonly report with an empty `File.type`. */
export const IMAGE_FILENAME_EXTENSION =
  /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|svg|tiff?|webp)$/i;

/**
 * Extension → media type for files dropped from a native file manager, where
 * the OS gives us a path and no media type at all. Deliberately small: the
 * value only steers labelling and the stored file extension, never parsing.
 */
const EXTENSION_MEDIA_TYPES: Readonly<Record<string, string>> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",

  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  json: "application/json",
  md: "text/markdown",
  pdf: "application/pdf",
  rtf: "application/rtf",
  txt: "text/plain",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  yaml: "text/yaml",
  yml: "text/yaml",
  zip: "application/zip",
};

export function fileNameExtension(name: string): string {
  const base = name.trim().split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** Best-effort media type for a name the platform gave us untyped. */
export function mediaTypeForFileName(name: string): string | null {
  return EXTENSION_MEDIA_TYPES[fileNameExtension(name)] ?? null;
}

export function isImageMediaType(mimeType: string | null | undefined): boolean {
  return (mimeType ?? "").trim().toLowerCase().startsWith("image/");
}

/** Classify a browser File before it is read into an attachment. */
export function fileAttachmentKind(file: {
  name: string;
  type: string;
}): AttachmentKind {
  if (isImageMediaType(file.type)) return "image";
  if (!file.type.trim() && IMAGE_FILENAME_EXTENSION.test(file.name))
    return "image";
  return "document";
}

/** Classify an attachment already on the wire. */
export function attachmentKind(
  attachment: Pick<ImageInput, "mime_type" | "name" | "url">,
): AttachmentKind {
  if (isImageMediaType(attachment.mime_type)) return "image";
  if (attachment.mime_type?.trim()) return "document";
  if (/^data:image\//i.test(attachment.url.trim())) return "image";
  const name = attachment.name?.trim();
  if (name && IMAGE_FILENAME_EXTENSION.test(name)) return "image";
  if (name) return "document";
  // Legacy inputs carried no media type; treat the untyped remainder as an
  // image so existing transcripts keep rendering their thumbnails.
  return "image";
}

export function isDocumentAttachment(
  attachment: Pick<ImageInput, "mime_type" | "name" | "url">,
): boolean {
  return attachmentKind(attachment) === "document";
}
