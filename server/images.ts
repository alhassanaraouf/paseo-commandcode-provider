import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function expandHomeDir(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

/**
 * Attachments live under PASEO_HOME rather than os.tmpdir(): macOS reaps
 * /tmp children after ~3 days, which would delete files a still-running session
 * refers to. Falls back to tmpdir when PASEO_HOME is not writable.
 */
function attachmentRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.PASEO_HOME ?? "~/.paseo";
  return path.join(path.resolve(expandHomeDir(home)), "plugin-data", "commandcode-provider");
}

export class ImageMaterializer {
  private directory: string | null = null;
  private readonly files = new Map<string, { path: string; bytes: number }>();
  private retainedBytes = 0;

  constructor(
    private readonly maxBytes = MAX_MATERIALIZED_IMAGE_BYTES,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

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

  clear(): void {
    this.files.clear();
    this.retainedBytes = 0;
    const directory = this.directory;
    this.directory = null;
    if (!directory) return;
    // Only remove the leaf we created; a PASEO_HOME root is shared with the
    // other plugin-data directories and must survive.
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
    const root = attachmentRoot(this.env);
    try {
      mkdirSync(root, { mode: PRIVATE_DIRECTORY_MODE, recursive: true });
      return mkdtempSync(path.join(root, `${ATTACHMENT_DIRECTORY_PREFIX}`));
    } catch {
      // A read-only or missing PASEO_HOME still leaves tmpdir usable.
      const directory = mkdtempSync(path.join(os.tmpdir(), ATTACHMENT_DIRECTORY_PREFIX));
      chmodSync(directory, PRIVATE_DIRECTORY_MODE);
      return directory;
    }
  }
}