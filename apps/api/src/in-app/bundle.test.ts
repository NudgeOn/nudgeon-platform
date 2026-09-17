import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { compileBundle, unpackArchive, hash, type SourceFile } from "./bundle";
const file = (path: string, text: string): SourceFile => ({
  path,
  base64: Buffer.from(text).toString("base64"),
});
describe("in-app static bundle boundary", () => {
  it("flattens local styles/scripts and pins executable bytes by hash", () => {
    const a = compileBundle([
      file(
        "index.html",
        '<link rel="stylesheet" href="styles.css"><h1>Hi</h1><script src="main.js"></script>',
      ),
      file("styles.css", "h1{color:green}"),
      file("main.js", "document.body.dataset.test='ok';"),
    ]);
    expect(a.html).toContain("h1{color:green}");
    expect(a.html).toContain("dataset.test");
    expect(a.html).toContain("script-src 'sha256-");
    expect(a.html).toContain("connect-src 'none'");
    expect(a.artifact_sha256).toBe(hash(a.html));
    expect(a.html).not.toContain('src="main.js"');
  });
  it.each([
    '<script src="https://evil.test/a.js"></script>',
    '<iframe src="index.html"></iframe>',
    '<img src="missing.png">',
    '<p onclick="alert(1)">x</p>',
    '<base href="https://evil.test">',
    '<meta http-equiv="refresh" content="0;url=https://evil.test">',
    '<a href="javascript:alert(1)">x</a>',
    '<script type="module">import x from "x"</script>',
    '<style>@import "external.css";</style>',
    "<svg><script>alert(1)</script></svg>",
  ])("rejects unsafe source %s", (html) => {
    expect(() => compileBundle([file("index.html", html)])).toThrow();
  });
  it.each([
    "../index.html",
    "/index.html",
    "a/../index.html",
    "a\\index.html",
    "%2e%2e/index.html",
  ])("rejects ambiguous paths %s", (path) => {
    expect(() =>
      compileBundle([file("index.html", "hi"), file(path, "x")]),
    ).toThrow();
  });
  it("rejects duplicate and case-colliding names", () =>
    expect(() =>
      compileBundle([file("index.html", "hi"), file("INDEX.HTML", "other")]),
    ).toThrow("Duplicate"));
  it("rejects unregistered native mechanisms and accepts explicit actions", () => {
    expect(() =>
      compileBundle([file("index.html", "hi")], {
        actions: { go: { type: "deep_link", url: "javascript://alert" } },
      }),
    ).toThrow();
    expect(
      compileBundle([file("index.html", "hi")], {
        actions: { go: { type: "open_url", url: "https://nudgeon.io" } },
      }).manifest.actions.go?.type,
    ).toBe("open_url");
  });
  it("reads ZIPs without extracting files on the host", () => {
    const bytes = zipSync({ "index.html": strToU8("<h1>Hello</h1>") });
    expect(compileBundle(unpackArchive(bytes)).html).toContain("Hello");
  });
  it("enforces actual inflated size against a compression bomb", () => {
    const bytes = zipSync({
      "index.html": new Uint8Array(9 * 1024 * 1024).fill(65),
    });
    expect(bytes.length).toBeLessThan(100000);
    expect(() => unpackArchive(bytes)).toThrow("size limit");
  });
  it("rejects disguised images and ZIP symlinks", () => {
    expect(() =>
      compileBundle([
        file("index.html", '<img src="fake.png">'),
        file("fake.png", "<script>evil</script>"),
      ]),
    ).toThrow("extension");
    const zip = Buffer.from(zipSync({ "index.html": strToU8("hello") }));
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE((0o120777 << 16) >>> 0, central + 38);
    expect(() => unpackArchive(zip)).toThrow("symlinks");
  });
  it("requires the source root entrypoint", () =>
    expect(() => compileBundle([file("event/index.html", "hi")])).toThrow(
      "Missing asset",
    ));
});
