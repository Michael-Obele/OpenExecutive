/**
 * `oe_knowledge` — everything the company knows.
 *
 * Durbar's knowledge surface is smaller than the reference Python backend:
 * builtin/failures are read-only files on disk, there is no mutable
 * builtin/failure store. Uploads go to `/documents` (company knowledge).
 * This tool exposes what Durbar actually serves — 10 read/search actions.
 *
 * Writable knowledge (create/replace/delete builtin/failure) and
 * `peek_external` are intentionally not exposed: Durbar's builtin corpus
 * lives as Markdown files on disk (`knowledge/builtin/`) and is indexed
 * at boot via FTS5. There is no mutable store to POST/PUT/DELETE against,
 * and external sources are not yet indexed (external stays empty). Keeping
 * those actions would make the tool surface lie — every call would 404.
 * If Durbar later adds a writable store, re-add them with real routes.
 */

import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, extname, resolve, sep } from "node:path";
import { backendForm } from "../backend.ts";
import { type ActionSpec, defineDomainTool, optionalList, optionalNumber, optionalText, text } from "./registry.ts";

const DOMAINS = "One of: strategy | finance | hr | legal | operations | marketing | board | product (upload also accepts general).";
const FILENAME = "Filename matching ^[A-Za-z0-9_-]+\\.md$ (built-in knowledge is Markdown only).";
const SEARCH_SOURCES = "Subset of: builtin | company | failures | external.";

const MIME_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".md": "text/markdown",
  ".txt": "text/plain",
};

const DOCUMENT_ROOT = process.env.MCP_DOCUMENT_ROOT ?? process.cwd();
const MAX_UPLOAD_BYTES = (() => {
  const n = Number(process.env.MCP_MAX_UPLOAD_BYTES ?? 50 * 1024 * 1024);
  return Number.isFinite(n) && n > 0 ? n : 50 * 1024 * 1024;
})();

async function uploadDocument(input: Record<string, unknown>): Promise<unknown> {
  const filePath = String(input.file_path ?? "");
  if (!filePath) throw new Error("upload_document: 'file_path' is required");

  const requested = resolve(filePath);
  if ((await lstat(requested).catch(() => null))?.isSymbolicLink()) {
    throw new Error(`upload_document: '${filePath}' is a symlink; uploads must be real files inside MCP_DOCUMENT_ROOT.`);
  }
  const resolved = await realpath(requested).catch(() => {
    throw new Error(`upload_document: cannot resolve '${filePath}'`);
  });
  const root = await realpath(resolve(DOCUMENT_ROOT)).catch(() => resolve(DOCUMENT_ROOT));
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`upload_document: '${filePath}' is outside MCP_DOCUMENT_ROOT (${root}). Set MCP_DOCUMENT_ROOT to widen the allowed tree.`);
  }
  const filename = basename(resolved);
  const extension = extname(filename).toLowerCase();
  if (!(extension in MIME_TYPES)) {
    throw new Error(`upload_document: unsupported file type '${extension}'. Allowed: ${Object.keys(MIME_TYPES).join(", ")}`);
  }
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new Error(`upload_document: cannot open '${filePath}' (symlinks are refused).`);
  });
  let bytes: Buffer;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`upload_document: '${filePath}' is not a regular file`);
    if (info.size > MAX_UPLOAD_BYTES) throw new Error(`upload_document: ${info.size} bytes exceeds the ${MAX_UPLOAD_BYTES}-byte cap (MCP_MAX_UPLOAD_BYTES).`);
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  const form = new FormData();
  form.set("domain", String(input.domain ?? "general"));
  const mimeType = MIME_TYPES[extension] ?? "application/octet-stream";
  form.set("file", new Blob([bytes as unknown as Uint8Array], { type: mimeType }), filename);
  return backendForm("/documents", form);
}

const actions: ActionSpec[] = [
  { name: "list_builtin", description: "List every built-in knowledge file with its size.", method: "GET", path: "/knowledge/builtin" },
  {
    name: "get_builtin",
    description: "Read one built-in knowledge file's full Markdown.",
    method: "GET",
    path: "/knowledge/builtin/:domain/:filename",
    fields: { domain: text(DOMAINS), filename: text(FILENAME) },
  },
  { name: "list_failures", description: "List every failure-library file with its size.", method: "GET", path: "/knowledge/failures" },
  {
    name: "get_failure",
    description: "Read one failure-library file's full Markdown.",
    method: "GET",
    path: "/knowledge/failures/:domain/:filename",
    fields: { domain: text(DOMAINS), filename: text(FILENAME) },
  },
  { name: "list_external", description: "List third-party research sources with ingestion status, chunk counts and licence. Read-only.", method: "GET", path: "/knowledge/external" },
  {
    name: "search",
    description:
      "Search every knowledge store at once and see which specialists would receive each hit. This is the diagnostic tool for 'why did the Executive answer that way?' — it returns per-store hits with distance, plus `specialists_that_would_see_this`.",
    method: "POST",
    path: "/knowledge/search",
    fields: {
      query: text("The search query."),
      domain_filter: optionalList(`Restrict to certain domains. ${DOMAINS}`),
      specialist: optionalText("Evaluate retrieval as this specialist sees it, e.g. 'finance'."),
      n_builtin: optionalNumber("Built-in hits to return (clamped to 25, default 5)."),
      n_company: optionalNumber("Company-document hits to return (clamped to 25, default 3)."),
      n_failures: optionalNumber("Failure-library hits to return (clamped to 25, default 3)."),
      n_external: optionalNumber("External-source hits to return (clamped to 25, default 5)."),
      include: optionalList(`Which stores to search. ${SEARCH_SOURCES}`),
    },
    bodyFrom: ["query", "domain_filter", "specialist", "n_builtin", "n_company", "n_failures", "n_external", "include"],
  },
  { name: "list_documents", description: "List the company's own uploaded documents.", method: "GET", path: "/documents" },
  {
    name: "get_document",
    description: "Read one company document's *extracted* text — exactly what was chunked into the vector store.",
    method: "GET",
    path: "/documents/:filename",
    fields: { filename: text("Uploaded filename, e.g. 'board-deck-q3.pdf'.") },
  },
  {
    name: "upload_document",
    description:
      "Upload a company document (PDF, DOCX, DOC, MD, TXT) by path on the MCP server's filesystem, index it into the company knowledge collection, and queue it for alert triage. Local deployments only — a hosted MCP server cannot read your disk; use the web UI there. The path must be a real file inside MCP_DOCUMENT_ROOT.",
    fields: {
      file_path: text("Path to the file, inside MCP_DOCUMENT_ROOT, on the machine running the MCP server."),
      domain: optionalText(`Domain to index under. ${DOMAINS} Defaults to 'general'.`),
    },
    custom: uploadDocument,
  },
  {
    name: "delete_document",
    description: "⚠️ destructive — delete a company document: removes the file and its chunks from the company collection.",
    method: "DELETE",
    path: "/documents/:filename",
    fields: { filename: text("Uploaded filename.") },
  },
];

export function registerKnowledgeTools(server: Parameters<typeof defineDomainTool>[0]): void {
  defineDomainTool(server, {
    name: "oe_knowledge",
    description:
      "Everything the company knows: curated built-in knowledge, the failure library, third-party research sources, and the company's own uploaded documents. `search` queries all four at once and reports which specialists would receive each hit.",
    actions,
  });
}
