/**
 * `oe_knowledge` — everything the company knows, and where it came from.
 *
 * Four distinct stores, deliberately never blended (a documented invariant):
 * - `builtin`  — curated MBA knowledge shipped with the repo.
 * - `failures` — the failure library, used to avoid repeating known mistakes.
 * - `external` — third-party research sources (read-only peeks).
 * - `documents`— the company's own uploaded docs.
 *
 * `search` queries all of them at once and reports which specialists would see
 * each hit, which is the fastest way to understand why the Executive answers
 * the way it does.
 */
import { backendForm } from "../backend.js";
import {
  type ActionSpec,
  defineDomainTool,
  optionalList,
  optionalNumber,
  optionalText,
  text,
} from "./registry.js";

const DOMAINS =
  "One of: strategy | finance | hr | legal | operations | marketing | board | product (upload also accepts general).";

const FILENAME =
  "Filename matching ^[A-Za-z0-9_-]+\\.md$ (built-in knowledge is Markdown only).";

const SEARCH_SOURCES = "Subset of: builtin | company | failures | external.";

const MIME_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".md": "text/markdown",
  ".txt": "text/plain",
};

/**
 * Uploads are confined to one directory tree, resolved with `realpath` before
 * the check so `..` and symlinks cannot walk out of it, and refused if the
 * path itself is a symlink. The file is `stat`ed and capped before it is read,
 * so an enormous file cannot exhaust the process.
 *
 * The threat is not the caller — a local MCP client already has the shell — but
 * the *content* the agent has read: an ingested paper, a watchlist signal or a
 * file in `company/docs` can tell it to "upload /etc/…" and have the contents
 * land back in the model's context through `get_document` or `search`.
 * `MCP_DOCUMENT_ROOT` therefore defaults to the working directory, not `/`.
 */
const DOCUMENT_ROOT = process.env.MCP_DOCUMENT_ROOT ?? process.cwd();
const MAX_UPLOAD_BYTES = Number(
  process.env.MCP_MAX_UPLOAD_BYTES ?? 50 * 1024 * 1024,
);

/**
 * `POST /documents` is multipart, and an MCP tool argument is JSON — so the
 * caller passes a **path on the MCP server's filesystem**. That only means
 * anything for a local (STDIO or localhost HTTP) deployment; a remotely hosted
 * MCP server cannot read the caller's disk, and the caller should use the web
 * UI instead.
 */
async function uploadDocument(
  input: Record<string, unknown>,
): Promise<unknown> {
  const filePath = String(input.file_path ?? "");
  if (!filePath) throw new Error("upload_document: 'file_path' is required");

  const { basename, extname, resolve, sep } = await import("node:path");
  const { lstat, open, realpath } = await import("node:fs/promises");
  const { constants } = await import("node:fs");

  const requested = resolve(filePath);
  if ((await lstat(requested).catch(() => null))?.isSymbolicLink()) {
    throw new Error(
      `upload_document: '${filePath}' is a symlink; uploads must be real files inside MCP_DOCUMENT_ROOT.`,
    );
  }

  const resolved = await realpath(requested).catch(() => {
    throw new Error(`upload_document: cannot resolve '${filePath}'`);
  });
  const root = await realpath(resolve(DOCUMENT_ROOT)).catch(() =>
    resolve(DOCUMENT_ROOT),
  );
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(
      `upload_document: '${filePath}' is outside MCP_DOCUMENT_ROOT (${root}). Set MCP_DOCUMENT_ROOT to widen the allowed tree.`,
    );
  }

  const filename = basename(resolved);
  const extension = extname(filename).toLowerCase();
  // Reject locally as well as remotely: the backend would 400 anyway, and this
  // costs the caller a round trip and a confusing error.
  if (!(extension in MIME_TYPES)) {
    throw new Error(
      `upload_document: unsupported file type '${extension}'. Allowed: ${Object.keys(MIME_TYPES).join(", ")}`,
    );
  }

  // Open the file we just checked rather than re-reading by path: `O_NOFOLLOW`
  // refuses a symlink swapped in after `realpath`, and the size is taken from
  // the handle (`fstat`) so the cap applies to the bytes actually read. This
  // closes the check-to-read race an `lstat` + `readFile` pair leaves open.
  const handle = await open(
    resolved,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch(() => {
    throw new Error(
      `upload_document: cannot open '${filePath}' (symlinks are refused).`,
    );
  });
  let bytes: Buffer;
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new Error(`upload_document: '${filePath}' is not a regular file`);
    }
    if (info.size > MAX_UPLOAD_BYTES) {
      throw new Error(
        `upload_document: ${info.size} bytes exceeds the ${MAX_UPLOAD_BYTES}-byte cap (MCP_MAX_UPLOAD_BYTES).`,
      );
    }
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }

  const form = new FormData();
  form.set("domain", String(input.domain ?? "general"));
  // Bun/Node accept a Buffer here; the cast is only to satisfy TS's BlobPart
  // typing for Uint8Array<ArrayBufferLike>.
  form.set(
    "file",
    new Blob([bytes as unknown as BlobPart], { type: MIME_TYPES[extension] }),
    filename,
  );

  return backendForm("/documents", form);
}

/** The built-in and failure stores expose the same shape, so they share a table. */
function markdownStore(
  name: "builtin" | "failures",
  label: string,
  hint: string,
): ActionSpec[] {
  const singular = name === "builtin" ? "builtin" : "failure";
  return [
    {
      name: `list_${name}`,
      description: `List every ${label} file with its size.`,
      method: "GET",
      path: `/knowledge/${name}`,
    },
    {
      name: `get_${singular}`,
      description: `Read one ${label} file's full Markdown.`,
      method: "GET",
      path: `/knowledge/${name}/:domain/:filename`,
      fields: { domain: text(DOMAINS), filename: text(FILENAME) },
    },
    {
      name: `create_${singular}`,
      description: `Add a new ${label} file. Fails with 409 if it already exists — use \`replace_${singular}\` to change an existing file. ${hint}`,
      method: "POST",
      path: `/knowledge/${name}`,
      fields: {
        domain: text(DOMAINS),
        filename: text(FILENAME),
        content: text("Full Markdown content of the file."),
      },
      // `domain` and `filename` must appear in the body as well as the path;
      // the backend's write model requires all three fields.
      bodyFrom: ["domain", "filename", "content"],
    },
    {
      name: `replace_${singular}`,
      description: `Replace an existing ${label} file's content (re-indexes its chunks). 404 if it does not exist.`,
      method: "PUT",
      path: `/knowledge/${name}/:domain/:filename`,
      fields: {
        domain: text(DOMAINS),
        filename: text(FILENAME),
        content: text("Full replacement Markdown content."),
      },
      bodyFrom: ["domain", "filename", "content"],
    },
    {
      name: `delete_${singular}`,
      description: `⚠️ destructive — delete a ${label} file and remove its indexed chunks.`,
      method: "DELETE",
      path: `/knowledge/${name}/:domain/:filename`,
      fields: { domain: text(DOMAINS), filename: text(FILENAME) },
    },
  ];
}

const actions: ActionSpec[] = [
  ...markdownStore(
    "builtin",
    "built-in knowledge",
    "Used to ground specialist answers.",
  ),
  ...markdownStore(
    "failures",
    "failure-library",
    "Used to avoid repeating known mistakes.",
  ),
  {
    name: "list_external",
    description:
      "List third-party research sources with ingestion status, chunk counts and licence. Read-only: sources are fetched and ingested by the backend, not through this tool.",
    method: "GET",
    path: "/knowledge/external",
  },
  {
    name: "peek_external",
    description:
      "Show the first few stored chunks of one external source — use it to judge relevance before trusting a citation.",
    method: "GET",
    path: "/knowledge/external/:source_id/peek",
    fields: {
      source_id: text(
        "External source id (letters, digits, hyphens, underscores).",
      ),
      limit: optionalNumber("How many chunks to return (1–25, default 5)."),
    },
    query: ["limit"],
  },
  {
    name: "search",
    description:
      "Search every knowledge store at once and see which specialists would receive each hit. This is the diagnostic tool for 'why did the Executive answer that way?' — it returns per-store hits with distance, plus `specialists_that_would_see_this`.",
    method: "POST",
    path: "/knowledge/search",
    fields: {
      query: text("The search query."),
      domain_filter: optionalList(`Restrict to certain domains. ${DOMAINS}`),
      specialist: optionalText(
        "Evaluate retrieval as this specialist sees it, e.g. 'finance'.",
      ),
      n_builtin: optionalNumber(
        "Built-in hits to return (clamped to 25, default 5).",
      ),
      n_company: optionalNumber(
        "Company-document hits to return (clamped to 25, default 3).",
      ),
      n_failures: optionalNumber(
        "Failure-library hits to return (clamped to 25, default 3).",
      ),
      n_external: optionalNumber(
        "External-source hits to return (clamped to 25, default 5).",
      ),
      include: optionalList(`Which stores to search. ${SEARCH_SOURCES}`),
    },
    bodyFrom: [
      "query",
      "domain_filter",
      "specialist",
      "n_builtin",
      "n_company",
      "n_failures",
      "n_external",
      "include",
    ],
  },
  {
    name: "list_documents",
    description: "List the company's own uploaded documents.",
    method: "GET",
    path: "/documents",
  },
  {
    name: "get_document",
    description:
      "Read one company document's *extracted* text — exactly what was chunked into the vector store, so this shows what the Executive really sees (including the failure mode where a scanned PDF extracts to nothing).",
    method: "GET",
    path: "/documents/:filename",
    fields: { filename: text("Uploaded filename, e.g. 'board-deck-q3.pdf'.") },
  },
  {
    name: "upload_document",
    description:
      "Upload a company document (PDF, DOCX, DOC, MD, TXT) by path on the MCP server's filesystem, index it into the company knowledge collection, and queue it for alert triage. Local deployments only — a hosted MCP server cannot read your disk; use the web UI there. The path must be a real file inside MCP_DOCUMENT_ROOT.",
    fields: {
      file_path: text(
        "Path to the file, inside MCP_DOCUMENT_ROOT, on the machine running the MCP server.",
      ),
      domain: optionalText(
        `Domain to index under. ${DOMAINS} Defaults to 'general'.`,
      ),
    },
    custom: uploadDocument,
  },
  {
    name: "delete_document",
    description:
      "⚠️ destructive — delete a company document: removes the file and its chunks from the company collection. The Executive stops seeing it immediately.",
    method: "DELETE",
    path: "/documents/:filename",
    fields: { filename: text("Uploaded filename.") },
  },
];

export function registerKnowledgeTools(
  server: Parameters<typeof defineDomainTool>[0],
) {
  defineDomainTool(server, {
    name: "oe_knowledge",
    description:
      "Everything the company knows: curated built-in knowledge, the failure library, third-party research sources, and the company's own uploaded documents. `search` queries all four at once and reports which specialists would receive each hit.",
    actions,
  });
}
