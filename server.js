// MCP server: Brave Search restricted to the health-librarianship
// professional-bodies Goggle. Companion to the NHS-domain Goggle server;
// deliberately a SEPARATE connector so the two strands can be enabled and
// disabled independently and their provenance never conflated.
//
// The Goggle boosts rather than restricts, so this server over-fetches from
// Brave and then filters to the allowlist parsed from the Goggle file itself.
//
// Required environment variables (set as secrets in the Render dashboard):
//   BRAVE_API_KEY  - Brave Search API subscription token
//   GOGGLE_URL     - public URL of health_librarianship_bodies.goggle
// Optional:
//   GOGGLE_PARAM   - "goggles" (default) or "goggles_id" for older API plans
//   LIST_VERSION   - fallback only; normally parsed from the Goggle header
//   PORT           - supplied by Render

import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
const GOGGLE_URL = process.env.GOGGLE_URL;
const GOGGLE_PARAM = process.env.GOGGLE_PARAM || "goggles";
const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

if (!BRAVE_API_KEY) throw new Error("BRAVE_API_KEY is not set");
if (!GOGGLE_URL) throw new Error("GOGGLE_URL is not set");

// Allowlist is parsed from the Goggle file itself at startup, so the Gist is the
// single source of truth: no second copy of the domain list to drift out of sync.
let ALLOW = [];
let LIST_VERSION = process.env.LIST_VERSION || "unversioned";

function parseGoggle(text) {
  const sites = [];
  let version = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("!")) {
      const m = line.match(/domain list\s+(v[\d.]+)/i);
      if (m) version = m[1];
      continue;
    }
    const m = line.match(/^\$boost,site=(.+)$/i) || line.match(/^\$site=(.+)$/i);
    if (m) sites.push(m[1].trim().toLowerCase());
  }
  return { sites, version };
}

async function loadAllowlist() {
  const res = await fetch(GOGGLE_URL, { headers: { Accept: "text/plain" } });
  if (!res.ok) throw new Error(`Could not fetch Goggle ${GOGGLE_URL}: HTTP ${res.status}`);
  const { sites, version } = parseGoggle(await res.text());
  if (sites.length === 0) throw new Error("Goggle parsed to zero site rules - refusing to start");
  ALLOW = sites;
  if (version) LIST_VERSION = version;
  console.log(`allowlist loaded: ${ALLOW.length} domains, list ${LIST_VERSION}`);
}

function onList(hostname) {
  const h = (hostname || "").toLowerCase();
  return ALLOW.some((d) => h === d || h.endsWith("." + d));
}

async function braveSearch(query, count) {
  // Over-fetch: the Goggle boosts rather than restricts, so listed domains can sit
  // below unlisted ones. Ask Brave for its maximum, then filter to the allowlist.
  const url = new URL(BRAVE_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("count", "20");
  url.searchParams.set(GOGGLE_PARAM, GOGGLE_URL);

  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": BRAVE_API_KEY,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    // Fail loudly. A silent empty result is indistinguishable from
    // "this literature does not exist", which is the failure mode that matters.
    throw new Error(
      `Brave API ${res.status} ${res.statusText}: ${body.slice(0, 300)}`
    );
  }

  const data = await res.json();
  const web = (data.web && data.web.results) || [];

  const mapped = web.map((r) => ({
    title: r.title ?? null,
    url: r.url ?? null,
    hostname: r.meta_url?.hostname ?? (r.url ? new URL(r.url).hostname : null),
    description: r.description ?? null,
    page_age: r.page_age ?? null,
    language: r.language ?? null,
  }));

  const kept = mapped.filter((r) => onList(r.hostname)).slice(0, count);
  const dropped = mapped.filter((r) => !onList(r.hostname));

  return {
    query,
    requested_count: count,
    brave_returned: mapped.length,
    on_list_returned: kept.length,
    filtered_out: dropped.length,
    filtered_out_hosts: [...new Set(dropped.map((r) => r.hostname))].sort(),
    goggle_url: GOGGLE_URL,
    domain_list_version: LIST_VERSION,
    allowlist_size: ALLOW.length,
    retrieved_utc: new Date().toISOString(),
    results: kept.map((r, i) => ({ rank: i + 1, ...r })),
  };
}

function buildServer() {
  const server = new McpServer({
    name: "health-lib-bodies-search",
    version: "1.0.0",
  });

  server.registerTool(
    "search_professional_bodies",
    {
      title: "Search health librarianship professional bodies",
      description:
        "Web search restricted by Goggle to professional and membership bodies " +
        "for health library and knowledge services (CILIP and its Health Libraries " +
        "Group, MLA, CHLA/ABSC, Health Libraries Australia, EAHIL, IFLA and others, " +
        "UK and international). Returns structured JSON. This strand is the " +
        "profession's own discourse and is advocacy-inflected; international " +
        "material describes other health systems and is horizon-scanning evidence, " +
        "not UK evidence. Supports no completeness claim.",
      inputSchema: {
        query: z.string().min(1).describe("The search query"),
        count: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(10)
          .describe("Number of results to return (default 10, max 20)"),
      },
    },
    async ({ query, count }) => {
      const payload = await braveSearch(query, count ?? 10);
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 1) }],
      };
    }
  );

  return server;
}

const app = express();
app.use(express.json({ limit: "4mb" }));

app.get("/healthz", (_req, res) =>
  res.json({ ok: true, goggle_param: GOGGLE_PARAM, list_version: LIST_VERSION,
             allowlist_size: ALLOW.length, goggle_url: GOGGLE_URL })
);

// Stateless Streamable HTTP: a fresh server and transport per request, so
// there is no session state to leak between callers.
app.post("/mcp", async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: String(err && err.message) },
        id: null,
      });
    }
  }
});

const methodNotAllowed = (_req, res) =>
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

const port = process.env.PORT || 3000;
await loadAllowlist();   // refuse to start on an unreachable or empty Goggle
app.listen(port, () => {
  console.log(`health-lib-bodies MCP listening on ${port}`);
});
