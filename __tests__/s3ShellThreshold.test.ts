import { describe, it, expect, beforeAll, vi } from "vitest";
import { S3 } from "../src/components/S3";
import { S3Core } from "../src/core/S3Core";
import {
  IS3Provider, S3RequestOptions, PresignedUpload, PresignedDownload, MultipartPart,
} from "../src/types";

class FakeProvider implements IS3Provider {
  async presignUpload(key: string, _opts: S3RequestOptions): Promise<PresignedUpload> {
    return { url: `https://example/upload/${key}`, method: "PUT", headers: {}, expiresAt: Date.now() + 60_000 };
  }
  async presignDownload(key: string, _opts: S3RequestOptions): Promise<PresignedDownload> {
    return { url: `https://example/download/${key}`, method: "GET", expiresAt: Date.now() + 60_000 };
  }
  async deleteObject(_key: string, _opts: S3RequestOptions): Promise<void> {}
  async initiateMultipart(_key: string, _opts: S3RequestOptions): Promise<{ uploadId: string }> {
    return { uploadId: "u1" };
  }
  async presignPart(_key: string, _uploadId: string, _partNumber: number, _opts: S3RequestOptions): Promise<PresignedUpload> {
    return { url: "https://example/part", method: "PUT", headers: {}, expiresAt: Date.now() + 60_000 };
  }
  async completeMultipart(_key: string, _uploadId: string, _parts: MultipartPart[], _opts: S3RequestOptions): Promise<{ etag: string }> {
    return { etag: "merged" };
  }
  async abortMultipart(_key: string, _uploadId: string, _opts: S3RequestOptions): Promise<void> {}
}

beforeAll(() => {
  if (!customElements.get("s3-uploader")) customElements.define("s3-uploader", S3);
});

/**
 * Pins the multipart routing boundary: `upload()` chooses multipart when
 * `file.size > multipartThreshold` — a strict `>`. The threshold value
 * itself takes the single-PUT path; only `threshold + 1` crosses into
 * multipart. A regression that flipped this to `>=` would silently push
 * exactly-threshold-sized files through the heavier multipart control plane.
 */
describe("S3 upload() multipart threshold boundary", () => {
  function makeShell(): { s3: S3; single: ReturnType<typeof vi.spyOn>; multi: ReturnType<typeof vi.spyOn> } {
    const s3 = document.createElement("s3-uploader") as S3;
    const core = new S3Core(new FakeProvider());
    core.bucket = "b";
    s3.attachLocalCore(core);
    document.body.appendChild(s3);
    // Stub the two routing targets so the test asserts only the branch
    // selection, not the XHR data plane (which needs a real browser).
    const single = vi.spyOn(s3 as any, "_doSingle").mockResolvedValue("single-url");
    const multi = vi.spyOn(s3 as any, "_doMultipart").mockResolvedValue("multipart-url");
    return { s3, single, multi };
  }

  it("size === threshold takes the single-PUT path (strict >)", async () => {
    const { s3, single, multi } = makeShell();
    s3.multipartThreshold = 1024;
    s3.file = new Blob([new Uint8Array(1024)]);
    await s3.upload();
    expect(single).toHaveBeenCalledTimes(1);
    expect(multi).not.toHaveBeenCalled();
  });

  it("size === threshold + 1 crosses into multipart", async () => {
    const { s3, single, multi } = makeShell();
    s3.multipartThreshold = 1024;
    s3.file = new Blob([new Uint8Array(1025)]);
    await s3.upload();
    expect(multi).toHaveBeenCalledTimes(1);
    expect(single).not.toHaveBeenCalled();
  });

  it("size === threshold - 1 takes the single-PUT path", async () => {
    const { s3, single, multi } = makeShell();
    s3.multipartThreshold = 1024;
    s3.file = new Blob([new Uint8Array(1023)]);
    await s3.upload();
    expect(single).toHaveBeenCalledTimes(1);
    expect(multi).not.toHaveBeenCalled();
  });
});
