import { test } from "node:test";
import assert from "node:assert/strict";
import { ALLOWED_MIME, STORED_EXTENSIONS, mimeFromUrl, objectNameFor } from "../functions/utils/fileTypes";

test("objectNameFor derives the extension from the MIME type, not the filename", () => {
  assert.equal(objectNameFor("job-1", "application/pdf"), "uploads/job-1/file.pdf");
  assert.equal(objectNameFor("job-1", "image/jpeg"), "uploads/job-1/file.jpg");
  assert.equal(objectNameFor("job-1", "image/png"), "uploads/job-1/file.png");
  assert.equal(objectNameFor("job-1", "image/webp"), "uploads/job-1/file.webp");
});

test("every accepted upload is stored under an extension /process and /cleanup look for", () => {
  for (const mime of ALLOWED_MIME) {
    const ext = objectNameFor("j", mime).split(".").pop()!;
    assert.ok(STORED_EXTENSIONS.includes(ext), `${mime} -> ${ext}`);
  }
});

test("mimeFromUrl reads the extension from a signed URL path", () => {
  const signed = (ext: string) =>
    `https://s3.example.com/ocr-agent/uploads/abc/file.${ext}?X-Amz-Signature=deadbeef&X-Amz-Expires=3600`;
  assert.equal(mimeFromUrl(signed("pdf")), "application/pdf");
  assert.equal(mimeFromUrl(signed("png")), "image/png");
  assert.equal(mimeFromUrl(signed("webp")), "image/webp");
  assert.equal(mimeFromUrl(signed("jpg")), "image/jpeg");
  assert.equal(mimeFromUrl(signed("jpeg")), "image/jpeg");
});

test("mimeFromUrl ignores look-alike extensions in the query string", () => {
  assert.equal(mimeFromUrl("https://h/uploads/abc/file.png?name=x.pdf"), "image/png");
});
