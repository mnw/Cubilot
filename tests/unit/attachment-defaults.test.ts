import { describe, expect, test } from "bun:test";
import { buildAllowedExtensions, DEFAULT_ALLOWED_EXTENSIONS } from "../../hub/core/attachments";

// The six types a ticket (and a chat) may carry out of the box. config.yml can still override the list.
describe("default upload allowlist", () => {
  test("pdf, md, txt, png, jpg and jpeg, and nothing executable", () => {
    expect([...DEFAULT_ALLOWED_EXTENSIONS].sort()).toEqual(["jpeg", "jpg", "md", "pdf", "png", "txt"]);
    const set = buildAllowedExtensions(undefined);
    for (const ext of ["pdf", "md", "txt", "png", "jpg", "jpeg"]) expect(set.has(ext)).toBe(true);
    for (const ext of ["exe", "sh", "html", "svg", "js"]) expect(set.has(ext)).toBe(false);
  });

  test("an explicit list overrides the defaults", () => {
    expect([...buildAllowedExtensions("pdf, .TXT")].sort()).toEqual(["pdf", "txt"]);
  });
});
