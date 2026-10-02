import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ponytail: `commandcode -p` has no image flag, but read_file turns an absolute
// path to a .png/.jpg/... into a real image block for vision-capable models, so
// images are written to a private directory and referenced by path in the text.
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/bmp": "bmp",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/tiff": "tiff",
  "image/webp": "webp",
};
const ATTACHMENT_DIRECTORY_PREFIX = "paseo-commandcode-attachments-";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_MATERIALIZED_IMAGE_BYTES = 16 * 1024 * 1024;

/**
 * Attachments must live under a temp root. The CLI auto-allows reads from
 * `systemTempRoots()` (os.tmpdir(), /tmp, $TMPDIR) and the workspace roots;
 * anything else outside the workspace needs an interactive approval, which
 * headless cannot grant, so read_file comes back `tool_denied` and the turn ends
 * with no response. Verified against commandcode 1.74.0:
 *
 *   /tmp/<image>.png                  -> read, image returned
 *   ~/.paseo/plugin-data/.../<image>  -> tool_denied (also with --add-dir)
 *   ~/.paseo/plugin-data/.../<image>  -> read, but only under --yolo
 *
 * macOS reaps /tmp children after ~3 days, so lifetime is bounded instead of
 * location: `release` deletes each turn's files once the turn ends, and `clear`
 * removes the directory on connection close. Nothing survives its own turn.
 */
function attachmentRoot(): string {
  return os.tmpdir();
}

export class ImageMaterializer {
  private directory: string | null = null;
  private readonly files = new Map<string, { path: string; bytes: number }>();
  private retainedBytes = 0;

  constructor(private readonly maxBytes = MAX_MATERIALIZED_IMAGE_BYTES) {}

  materialize(image: { data: string; mimeType: string }): string {
    const data = image.data.startsWith("data:")
      ? (image.data.match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/u)?.[2] ?? "")
      : image.data;
    const bytes = Buffer.from(data, "base64");
    if (bytes.byteLength === 0) throw new Error("image payload is empty");
    if (bytes.byteLength > this.maxBytes) {
      throw new Error(
        `image is ${bytes.byteLength} bytes, over the ${this.maxBytes} byte limit`,
      );
    }
    const hash = createHash("sha256").update(bytes).digest("hex");
    const existing = this.files.get(hash);
    if (existing) return existing.path;
    if (this.retainedBytes + bytes.byteLength > this.maxBytes) {
      throw new Error("materialized image budget exceeded");
    }
    const file = path.join(this.ensureDirectory(), `${hash}.${this.extension(image.mimeType)}`);
    writeFileSync(file, bytes, { mode: PRIVATE_FILE_MODE });
    chmodSync(file, PRIVATE_FILE_MODE);
    this.files.set(hash, { path: file, bytes: bytes.byteLength });
    this.retainedBytes += bytes.byteLength;
    return file;
  }

  /**
   * Delete the files a finished turn materialized. A path still held by another
   * live turn is kept, so overlapping turns cannot pull the file out from under
   * a model that is about to read it.
   */
  release(paths: Iterable<string>): void {
    const releasing = new Set(paths);
    for (const [hash, file] of [...this.files]) {
      if (!releasing.has(file.path)) continue;
      this.files.delete(hash);
      this.retainedBytes -= file.bytes;
      try {
        unlinkSync(file.path);
      } catch {
        // Already gone (or the directory was reaped): nothing to reclaim.
      }
    }
  }

  clear(): void {
    this.files.clear();
    this.retainedBytes = 0;
    const directory = this.directory;
    this.directory = null;
    if (!directory) return;
    rmSync(directory, { force: true, recursive: true });
  }

  private extension(mimeType: string): string {
    return IMAGE_EXTENSIONS[mimeType] ?? "png";
  }

  private ensureDirectory(): string {
    if (this.directory && this.directoryIsReusable()) return this.directory;
    this.files.clear();
    this.retainedBytes = 0;
    this.directory = this.createDirectory();
    return this.directory;
  }

  private directoryIsReusable(): boolean {
    if (!this.directory) return false;
    try {
      if (!lstatSync(this.directory).isDirectory()) return false;
      chmodSync(this.directory, PRIVATE_DIRECTORY_MODE);
      return true;
    } catch {
      return false;
    }
  }

  private createDirectory(): string {
    // mkdtempSync creates the leaf 0700 already; chmod is belt-and-braces in
    // case a future platform default loosens it.
    const directory = mkdtempSync(path.join(attachmentRoot(), ATTACHMENT_DIRECTORY_PREFIX));
    chmodSync(directory, PRIVATE_DIRECTORY_MODE);
    return directory;
  }
}