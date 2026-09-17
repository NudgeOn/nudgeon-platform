import { createHash } from "node:crypto";
import { posix } from "node:path";
import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";
import postcss from "postcss";
import valueParser from "postcss-value-parser";
import { Unzip, UnzipInflate } from "fflate";
import { z } from "zod";
import { bridgeBootstrap } from "./bridge";

export const MAX_FILE = 8 * 1024 * 1024,
  MAX_TOTAL = 30 * 1024 * 1024,
  MAX_ARCHIVE = 10 * 1024 * 1024;
const types: Record<string, string> = {
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  woff2: "font/woff2",
};
export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("dismiss") }).strict(),
  z
    .object({
      type: z.literal("deep_link"),
      url: z
        .string()
        .max(2048)
        .refine(
          (v) =>
            /^[a-z][a-z0-9+.-]*:\/\//i.test(v) &&
            !/^(javascript|data|file|content|intent|http):/i.test(v),
        ),
    })
    .strict(),
  z
    .object({
      type: z.literal("open_url"),
      url: z
        .string()
        .url()
        .max(2048)
        .refine((v) => v.startsWith("https://")),
    })
    .strict(),
  z.object({ type: z.literal("copy"), text: z.string().max(1000) }).strict(),
]);
export const manifestSchema = z
  .object({
    format_version: z.literal(1).default(1),
    entrypoint: z.literal("index.html").default("index.html"),
    bridge_version: z.literal(1).default(1),
    display: z
      .object({
        type: z
          .enum(["modal", "fullscreen", "bottom", "transparent"])
          .default("modal"),
        backdrop_opacity: z.number().min(0).max(0.7).default(0.4),
      })
      .default({}),
    actions: z
      .record(z.string().regex(/^[a-zA-Z][\w-]{0,63}$/), actionSchema)
      .refine((v) => Object.keys(v).length <= 20)
      .default({}),
  })
  .strict();
export type Manifest = z.infer<typeof manifestSchema>;
export interface SourceFile {
  path: string;
  base64: string;
}
export function hash(data: string | Uint8Array) {
  return createHash("sha256").update(data).digest("hex");
}
export class BundleError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const fail = (message: string): never => {
  throw new BundleError("INVALID_BUNDLE", message);
};
function safePath(path: string) {
  if (
    !/^[a-zA-Z0-9_./-]+$/.test(path) ||
    path.startsWith("/") ||
    path.split("/").some((p) => !p || p === "." || p === "..") ||
    path.length > 200
  )
    fail(`Invalid path: ${path.slice(0, 100)}`);
  if (!types[path.split(".").pop()!.toLowerCase()])
    fail(`Unsupported file: ${path}`);
  return path;
}
/** Streaming inflated-byte limit, not the untrusted ZIP directory sizes. Never executes source. */
export function unpackArchive(bytes: Uint8Array): SourceFile[] {
  if (bytes.length > MAX_ARCHIVE) fail("ZIP exceeds 10 MiB");
  // Inspect ZIP central records for symlinks/encryption before streaming data. ZIP64 is unnecessary at our limits.
  const zipBytes = Buffer.from(bytes);
  let end = -1;
  for (
    let i = zipBytes.length - 22;
    i >= Math.max(0, zipBytes.length - 65557);
    i--
  )
    if (zipBytes.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) fail("Invalid ZIP directory");
  const entries = zipBytes.readUInt16LE(end + 10);
  let cursor = zipBytes.readUInt32LE(end + 16);
  if (
    entries > 200 ||
    zipBytes.readUInt16LE(end + 4) !== 0 ||
    zipBytes.readUInt16LE(end + 6) !== 0
  )
    fail("Too many entries or multi-part ZIP");
  for (let i = 0; i < entries; i++) {
    if (cursor + 46 > end || zipBytes.readUInt32LE(cursor) !== 0x02014b50)
      fail("Invalid ZIP directory");
    if (zipBytes.readUInt16LE(cursor + 8) & 1)
      fail("Encrypted ZIP is unsupported");
    if (((zipBytes.readUInt32LE(cursor + 38) >>> 16) & 0xf000) === 0xa000)
      fail("ZIP symlinks are unsupported");
    cursor +=
      46 +
      zipBytes.readUInt16LE(cursor + 28) +
      zipBytes.readUInt16LE(cursor + 30) +
      zipBytes.readUInt16LE(cursor + 32);
  }
  const files: SourceFile[] = [];
  let total = 0,
    count = 0;
  const zip = new Unzip((file) => {
    if (++count > 200) fail("Too many ZIP entries");
    if (file.name.endsWith("/")) {
      if (
        file.name.split("/").some((p) => p === "..") ||
        file.name.startsWith("/")
      )
        fail("Invalid directory");
      return;
    }
    safePath(file.name);
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (error, data, final) => {
      if (error) {
        if (error instanceof BundleError) throw error;
        fail("Invalid or encrypted ZIP");
      }
      total += data.length;
      size += data.length;
      if (size > MAX_FILE || total > MAX_TOTAL) {
        file.terminate();
        fail("Expanded ZIP exceeds size limit");
      }
      chunks.push(data);
      if (final)
        files.push({
          path: file.name,
          base64: Buffer.concat(chunks).toString("base64"),
        });
    };
    file.start();
  });
  zip.register(UnzipInflate);
  // Bound individual inflater output allocations by feeding compressed data in small chunks.
  for (let i = 0; i < bytes.length; i += 1024)
    zip.push(bytes.subarray(i, i + 1024), i + 1024 >= bytes.length);
  if (!files.length) fail("Empty or invalid ZIP");
  return files;
}
export function compileBundle(source: SourceFile[], manifestInput?: unknown) {
  if (!source.length || source.length > 200) fail("Use 1–200 files");
  const files = new Map<string, Buffer>();
  const names = new Set<string>();
  let total = 0;
  for (const file of source) {
    safePath(file.path);
    if (names.has(file.path.toLowerCase()))
      fail(`Duplicate path: ${file.path}`);
    names.add(file.path.toLowerCase());
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        file.base64,
      )
    )
      fail(`Invalid base64: ${file.path}`);
    const bytes = Buffer.from(file.base64, "base64");
    total += bytes.length;
    if (bytes.length > MAX_FILE || total > MAX_TOTAL)
      fail("Files exceed size limit");
    if (/\.(html|css|js|json)$/i.test(file.path) && bytes.length > 1024 * 1024)
      fail(`Text exceeds 1 MiB: ${file.path}`);
    const ext = file.path.split(".").pop()!.toLowerCase();
    const magic = bytes.subarray(0, 12);
    const valid =
      ext === "png"
        ? magic
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : ext === "jpg" || ext === "jpeg"
          ? magic[0] === 255 && magic[1] === 216 && magic[2] === 255
          : ext === "gif"
            ? /^GIF8[79]a/.test(magic.toString("ascii"))
            : ext === "webp"
              ? magic.toString("ascii", 0, 4) === "RIFF" &&
                magic.toString("ascii", 8, 12) === "WEBP"
              : ext === "woff2"
                ? magic.toString("ascii", 0, 4) === "wOF2"
                : true;
    if (!valid) fail(`File content does not match extension: ${file.path}`);
    files.set(file.path, bytes);
  }
  const text = (path: string) => {
    const b = files.get(path);
    if (!b) fail(`Missing asset: ${path}`);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(b!);
    } catch {
      return fail(`Invalid UTF-8: ${path}`);
    }
  };
  let manifest: Manifest;
  try {
    manifest = manifestSchema.parse(
      manifestInput ??
        (files.has("nudgeon.json") ? JSON.parse(text("nudgeon.json")) : {}),
    );
  } catch {
    return fail("Invalid nudgeon.json or action settings");
  }
  const resolve = (ref: string, from: string) => {
    if (!ref || /[:?#\\%]/.test(ref) || ref.startsWith("/"))
      fail(`Use relative bundled assets: ${ref.slice(0, 100)}`);
    const path = posix.normalize(posix.join(posix.dirname(from), ref));
    safePath(path);
    if (!files.has(path)) fail(`Missing asset: ${path}`);
    return path;
  };
  const data = (ref: string, from: string) => {
    const path = resolve(ref, from),
      ext = path.split(".").pop()!.toLowerCase();
    if (!["png", "jpg", "jpeg", "webp", "gif", "woff2"].includes(ext))
      fail(`Invalid image/font: ${path}`);
    return `data:${types[ext]};base64,${files.get(path)!.toString("base64")}`;
  };
  const css = (content: string, from: string) => {
    try {
      const root = postcss.parse(content);
      root.walkAtRules((rule) => {
        if (rule.name.toLowerCase() === "import")
          fail(`Bundle CSS locally: ${from}`);
      });
      root.walkDecls((decl) => {
        const val = valueParser(decl.value);
        val.walk((node) => {
          if (node.type === "function" && node.value.toLowerCase() === "url") {
            const ref = valueParser
              .stringify(node.nodes)
              .replace(/^['"]|['"]$/g, "");
            node.nodes = [
              {
                type: "string",
                quote: '"',
                value: data(ref, from),
                sourceIndex: 0,
                sourceEndIndex: 0,
              },
            ];
          }
        });
        decl.value = val.toString();
      });
      return root.toString();
    } catch (e) {
      if (e instanceof BundleError) throw e;
      return fail(`Invalid CSS: ${from}`);
    }
  };
  type Node = DefaultTreeAdapterMap["node"];
  type Element = DefaultTreeAdapterMap["element"];
  const doc = parse(text("index.html"));
  const setText = (node: Element, value: string) => {
    node.childNodes = [{ nodeName: "#text", value, parentNode: node }];
  };
  const scriptHashes: string[] = [];
  const checkJs = (js: string) => {
    if (/<\/script/i.test(js) || /\bimport\s*(?:\(|["'{*])/.test(js))
      fail("ES modules/dynamic import are not supported; use a classic bundle");
    scriptHashes.push(
      `'sha256-${createHash("sha256").update(js).digest("base64")}'`,
    );
    return js;
  };
  const visit = (node: Node) => {
    if ("tagName" in node) {
      const el = node as Element,
        tag = el.tagName;
      if (
        [
          "iframe",
          "frame",
          "frameset",
          "object",
          "embed",
          "base",
          "form",
          "svg",
          "math",
          "template",
          "video",
          "audio",
        ].includes(tag)
      )
        fail(`Unsupported element: ${tag}`);
      if (tag === "meta" && el.attrs.some((a) => a.name === "http-equiv"))
        fail("http-equiv is managed by NudgeOn");
      if (
        tag === "input" &&
        el.attrs.some(
          (a) => a.name === "type" && a.value.toLowerCase() === "file",
        )
      )
        fail("File inputs are not supported");
      for (const a of el.attrs) {
        if (
          /^on/i.test(a.name) ||
          [
            "srcdoc",
            "srcset",
            "ping",
            "action",
            "formaction",
            "target",
            "download",
            "nonce",
          ].includes(a.name)
        )
          fail(`Unsupported attribute: ${a.name}`);
        if (a.name === "style") a.value = css(a.value, "index.html");
        if (a.name === "href" && tag !== "link" && !a.value.startsWith("#"))
          fail("Use a registered action for navigation");
        if (a.name === "src" && tag !== "script") {
          if (tag !== "img") fail(`Unsupported src: ${tag}`);
          a.value = data(a.value, "index.html");
        }
      }
      if (tag === "link") {
        const href = el.attrs.find((a) => a.name === "href")?.value;
        if (
          el.attrs.find((a) => a.name === "rel")?.value !== "stylesheet" ||
          !href
        )
          fail("Only bundled stylesheets are supported");
        const path = resolve(href!, "index.html");
        el.tagName = el.nodeName = "style";
        el.attrs = [];
        setText(el, css(text(path), path));
      } else if (tag === "style")
        setText(
          el,
          css(
            el.childNodes.map((n) => ("value" in n ? n.value : "")).join(""),
            "index.html",
          ),
        );
      if (tag === "script") {
        if (
          el.attrs.some(
            (a) =>
              a.name === "type" &&
              !["text/javascript", "application/javascript"].includes(a.value),
          )
        )
          fail("Use classic JavaScript");
        const src = el.attrs.find((a) => a.name === "src")?.value;
        const js = src
          ? text(resolve(src, "index.html"))
          : el.childNodes.map((n) => ("value" in n ? n.value : "")).join("");
        el.attrs = [];
        setText(el, checkJs(js));
      }
    }
    if ("childNodes" in node) node.childNodes.forEach(visit);
  };
  visit(doc);
  checkJs(bridgeBootstrap);
  const csp = `default-src 'none'; script-src ${scriptHashes.join(" ")}; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  const html = serialize(doc).replace(
    "<head>",
    `<head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><script>${bridgeBootstrap}</script>`,
  );
  if (Buffer.byteLength(html) > MAX_TOTAL)
    fail("Compiled document exceeds 30 MiB");
  return {
    html,
    manifest,
    artifact_sha256: hash(html),
    source_bytes: total,
    files: source,
  };
}
