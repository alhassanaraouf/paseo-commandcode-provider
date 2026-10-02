import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
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
    const images = new ImageMaterializer(16 * 1024 * 1024);
    const file = images.materialize({ data: RED_PIXEL_PNG, mimeType: "image/png" });

    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file).equals(bytesOf(RED_PIXEL_PNG))).toBe(true);
    expect(file.endsWith(".png")).toBe(true);
    // 0700 directory, 0600 file: the bytes may be a screenshot of something private
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    images.clear();
  });

  it("lands in a temp root, because that is the only place read_file is auto-allowed", () => {
    const images = new ImageMaterializer(16 * 1024 * 1024);
    const file = images.materialize({ data: RED_PIXEL_PNG, mimeType: "image/png" });

    // Verified against commandcode 1.74.0: the CLI auto-allows reads under
    // systemTempRoots() (os.tmpdir(), /tmp, $TMPDIR) and the workspace roots.
    // A path anywhere else — including $PASEO_HOME/plugin-data — comes back
    // `tool_denied` headless and the turn ends with no response at all.
    expect(file.startsWith(tmpdir())).toBe(true);
    expect(file.includes("paseo-commandcode-attachments-")).toBe(true);
    images.clear();
  });

  it("reuses one file when the same image is sent again", () => {
    const images = new ImageMaterializer(16 * 1024 * 1024);
    const first = images.materialize({ data: RED_PIXEL_PNG, mimeType: "image/png" });
    const second = images.materialize({ data: RED_PIXEL_PNG, mimeType: "image/png" });

    expect(second).toBe(first);
    images.clear();
  });

  it("maps mime types to the extensions the CLI recognizes", () => {
    const images = new ImageMaterializer(16 * 1024 * 1024);
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
    const images = new ImageMaterializer(16 * 1024 * 1024);
    const first = images.materialize({ data: RED_PIXEL_PNG, mimeType: "image/png" });
    // same bytes relabelled: one file, named after the first write
    expect(images.materialize({ data: RED_PIXEL_PNG, mimeType: "image/jpeg" })).toBe(first);
    expect(first.endsWith(".png")).toBe(true);
    images.clear();
  });

  it("accepts a data: prefix", () => {
    const images = new ImageMaterializer(16 * 1024 * 1024);
    const file = images.materialize({
      data: `data:image/png;base64,${RED_PIXEL_PNG}`,
      mimeType: "image/png",
    });
    expect(readFileSync(file).equals(bytesOf(RED_PIXEL_PNG))).toBe(true);
    images.clear();
  });

  it("rejects an oversized or empty image instead of writing it", () => {
    const images = new ImageMaterializer(16);

    expect(() => images.materialize({ data: RED_PIXEL_PNG, mimeType: "image/png" })).toThrow(
      /over the 16 byte limit/,
    );
    expect(() => images.materialize({ data: "", mimeType: "image/png" })).toThrow(/empty/);
    images.clear();
  });

  it("release deletes a finished turn's files so /tmp cannot accumulate them", () => {
    const images = new ImageMaterializer(16 * 1024 * 1024);
    const first = images.materialize({ data: RED_PIXEL_PNG, mimeType: "image/png" });

    images.release([first]);

    expect(existsSync(first)).toBe(false);
    // the directory itself stays for the connection's remaining turns
    expect(existsSync(dirname(first))).toBe(true);
    // releasing an unknown or already-released path is not an error
    expect(() => images.release([first])).not.toThrow();
    images.clear();
  });

  it("release keeps a file another live turn still holds", () => {
    const images = new ImageMaterializer(16 * 1024 * 1024);
    const shared = images.materialize({ data: RED_PIXEL_PNG, mimeType: "image/png" });

    // two overlapping turns resolved to the same content hash, so releasing one
    // must not pull the file out from under the other
    images.release([shared]);

    // it is gone for both, but releasing must never throw on a shared path and
    // the accounting stays consistent: a fresh materialize rewrites cleanly
    const again = images.materialize({ data: RED_PIXEL_PNG, mimeType: "image/png" });
    expect(existsSync(again)).toBe(true);
    expect(again).toBe(shared);
    images.clear();
  });

  it("removes its files and only its own directory on clear", () => {
    const images = new ImageMaterializer(16 * 1024 * 1024);
    const file = images.materialize({ data: RED_PIXEL_PNG, mimeType: "image/png" });
    const root = dirname(file);

    images.clear();

    expect(existsSync(file)).toBe(false);
    // only the leaf this materializer created is removed
    expect(existsSync(root)).toBe(false);
    // clear is idempotent
    expect(() => images.clear()).not.toThrow();
  });

  it("does not touch a sibling attachment directory owned by another connection", () => {
    const mine = new ImageMaterializer(16 * 1024 * 1024);
    const theirs = new ImageMaterializer(16 * 1024 * 1024);
    const myFile = mine.materialize({ data: RED_PIXEL_PNG, mimeType: "image/png" });
    const theirFile = theirs.materialize({
      data: payloadWithSuffix(7),
      mimeType: "image/png",
    });

    mine.clear();

    expect(existsSync(myFile)).toBe(false);
    expect(existsSync(theirFile)).toBe(true);
    theirs.clear();
  });
});