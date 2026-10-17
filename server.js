// MCP server: Brave Search restricted to the health-librarianship
// professional-bodies Goggle. Companion to the NHS-domain Goggle server;
// deliberately a SEPARATE connector so the two strands can be enabled and
// disabled independently and their provenance never conflated.
//
// Required environment variables (set as secrets in the Render dashboard):
//   BRAVE_API_KEY  - Brave Search API subscription token
//   GOGGLE_URL     - public URL of health_librarianship_bodies.goggle
// Optional:
//   GOGGLE_PARAM   - "goggles" (default) or "goggles_id" for older API plans
//   LIST_VERSION   - domain-list version string echoed on every response
//   PORT           - supplied by Render

import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
const GOGGLE_URL = process.env.GOGGLE_URL;
const GOGGLE_PARAM = process.env.GOGGLE_PARAM || "goggles";
const LIST_VERSION = process.env.LIST_VERSION || "unversioned";
const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

if (!BRAVE_API_KEY) throw new Error("BRAVE_API_KEY is not set");
if (!GOGGLE_URL) throw new Error("GOGGLE_URL is not set");

async function braveSearch(query, count) {
  const url = new URL(BRAVE_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));
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
    // "this literature does not exist", which is the failure mode that
    // matters most in a search audit.
    throw new Error(
      `Brave API ${res.status} ${res.statusText}: ${body.slice(0, 300)}`
    );
  }

  const data = await res.json();
  const web = (data.web && data.web.results) || [];

  return {
    query,
    requested_count: count,
    returned_count: web.length,
    goggle_url: GOGGLE_URL,
    domain_list_version: LIST_VERSION,
    retrieved_utc: new Date().toISOString(),
    results: web.map((r, i) => ({
      rank: i + 1,
      title: r.title ?? null,
      url: r.url ?? null,
      hostname: r.meta_url?.hostname ?? (r.url ? new URL(r.url).hostname : null),
      description: r.description ?? null,
      page_age: r.page_age ?? null,
      language: r.language ?? null,
    })),
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
  res.json({ ok: true, goggle_param: GOGGLE_PARAM, list_version: LIST_VERSION })
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
app.listen(port, () => {
  console.log(`health-lib-bodies MCP listening on ${port}`);
});
