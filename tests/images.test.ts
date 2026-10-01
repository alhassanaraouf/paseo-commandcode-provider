import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ImageMaterializer } from "../server/images.js";

// 1x1 red PNG
const RED_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function bytesOf(base64: string): Buffer {
  return Buffer.from(base64, "base64");
}

/** Distinct bytes per mime case: dedupe is keyed on the content hash. */
function payloadWithSuffix(suffix: number): string {
  const base = bytesOf(RED_PIXEL_PNG);
  const extra = Buffer.alloc(suffix);
  for (let index = 0; index < suffix; index += 1) extra[index] = index + 1;
  return Buffer.concat([base, extra]).toString("base64");
}

describe("ImageMaterializer", () => {
  it("writes the image bytes to a private file under a hashed name", () => {
    const home = mkdtempSync(join(tmpdir(), "paseo-home-"));
    const images = new ImageMaterializer(16 * 1024 * 1024, { PASEO_HOME: home });
    const file = images.materialize({ data: RED_PIXEL_PNG, mimeType: "image/png" });

    expect(file.startsWith(join(home, "plugin-data", "commandcode-provider"))).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file).equals(bytesOf(RED_PIXEL_PNG))).toBe(true);
    expect(file.endsWith(".png")).toBe(true);
    // 0700 directory, 0600 file: the bytes may be a screenshot of something private
    expect(statSync(join(home, "plugin-data", "commandcode-provider")).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    images.clear();
  });

  it("keeps files out of os.tmpdir() so macOS reaping cannot delete them mid-session", () => {
    const home = mkdtempSync(join(tmpdir(), "paseo-home-"));
    const images = new ImageMaterializer(16 * 1024 * 1024, { PASEO_HOME: home });
    const file = images.materialize({ data: RED_PIXEL_PNG, mimeType: "image/png" });

    // the test's own mkdtemp is under tmpdir, but the attachment must be under PASEO_HOME
    expect(file.includes(`${home}/`)).toBe(true);
    images.clear();
  });

  it("reuses one file when the same image is sent again", () => {
    const home = mkdtempSync(join(tmpdir(), "paseo-home-"));
    const images = new ImageMaterializer(16 * 1024 * 1024, { PASEO_HOME: home });
    const first = images.materialize({ data: RED_PIXEL_PNG, mimeType: "image/png" });
    const second = images.materialize({ data: RED_PIXEL_PNG, mimeType: "image/png" });

    expect(second).toBe(first);
    images.clear();
  });

  it("maps mime types to the extensions the CLI recognizes", () => {
    const home = mkdtempSync(join(tmpdir(), "paseo-home-"));
    const images = new ImageMaterializer(16 * 1024 * 1024, { PASEO_HOME: home });
    // distinct bytes per case: dedupe is keyed on content hash, so identical
    // bytes under two mime types resolve to whichever landed first
    const cases: Array<[string, string]> = [
      ["image/jpeg", payloadWithSuffix(1)],
      ["image/webp", payloadWithSuffix(2)],
      ["image/gif", payloadWithSuffix(3)],
      ["image/tiff", payloadWithSuffix(4)],
    ];
    for (const [mimeType, data] of cases) {
      const extension = mimeType === "image/jpeg" ? ".jpg" : `.${mimeType.slice("image/".length)}`;
      // read_file's isVisionImagePath accepts png|jpe?g|gif|webp|bmp|tiff
      expect(images.materialize({ data, mimeType }).endsWith(extension)).toBe(true);
    }
    images.clear();
  });

  it("dedupes on bytes, not on the declared mime type", () => {
    const home = mkdtempSync(join(tmpdir(), "paseo-home-"));
    const images = new ImageMaterializer(16 * 1024 * 1024, { PASEO_HOME: home });
    const first = images.materialize({ data: RED_PIXEL_PNG, mimeType: "image/png" });
    // same bytes relabelled: one file, named after the first write
    expect(images.materialize({ data: RED_PIXEL_PNG, mimeType: "image/jpeg" })).toBe(first);
    expect(first.endsWith(".png")).toBe(true);
    images.clear();
  });

  it("accepts a data: prefix", () => {
    const home = mkdtempSync(join(tmpdir(), "paseo-home-"));
    const images = new ImageMaterializer(16 * 1024 * 1024, { PASEO_HOME: home });
    const file = images.materialize({
      data: `data:image/png;base64,${RED_PIXEL_PNG}`,
      mimeType: "image/png",
    });
    expect(readFileSync(file).equals(bytesOf(RED_PIXEL_PNG))).toBe(true);
    images.clear();
  });

  it("falls back to tmpdir when PASEO_HOME cannot hold a directory", () => {
    // a regular file where a directory must go: mkdir fails with ENOTDIR fast,
    // unlike a path under /proc or a permission-denied root
    const home = mkdtempSync(join(tmpdir(), "paseo-home-"));
    const blocked = join(home, "blocked");
    writeFileSync(blocked, "not a directory");
    const images = new ImageMaterializer(16 * 1024 * 1024, { PASEO_HOME: blocked });
    const file = images.materialize({ data: RED_PIXEL_PNG, mimeType: "image/png" });
    expect(existsSync(file)).toBe(true);
    expect(file.includes("paseo-commandcode-attachments-")).toBe(true);
    expect(file.startsWith(tmpdir())).toBe(true);
    images.clear();
  });

  it("rejects an oversized or empty image instead of writing it", () => {
    const home = mkdtempSync(join(tmpdir(), "paseo-home-"));
    const images = new ImageMaterializer(16, { PASEO_HOME: home });

    expect(() => images.materialize({ data: RED_PIXEL_PNG, mimeType: "image/png" })).toThrow(
      /over the 16 byte limit/,
    );
    expect(() => images.materialize({ data: "", mimeType: "image/png" })).toThrow(
      /empty/,
    );
    images.clear();
  });

  it("removes its files and only its own directory on clear", () => {
    const home = mkdtempSync(join(tmpdir(), "paseo-home-"));
    const images = new ImageMaterializer(16 * 1024 * 1024, { PASEO_HOME: home });
    const file = images.materialize({ data: RED_PIXEL_PNG, mimeType: "image/png" });
    const root = join(home, "plugin-data", "commandcode-provider");

    images.clear();

    expect(existsSync(file)).toBe(false);
    // the shared plugin-data root must survive for the other plugins
    expect(existsSync(root)).toBe(true);
    // clear is idempotent
    expect(() => images.clear()).not.toThrow();
  });
});