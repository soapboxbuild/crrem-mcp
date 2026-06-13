import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// In-memory cache (1-hour TTL)
// ---------------------------------------------------------------------------
const cache = new Map<string, { data: unknown; expires: number }>();

async function fetchData(path: string): Promise<unknown> {
  const cached = cache.get(path);
  if (cached && Date.now() < cached.expires) return cached.data;
  const url = `https://raw.githubusercontent.com/soapboxbuild/crrem-data/master/${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CRREM data not found: ${path} (HTTP ${res.status})`);
  const data = await res.json();
  cache.set(path, { data, expires: Date.now() + 3_600_000 });
  return data;
}

// ---------------------------------------------------------------------------
// Supported countries (actual files present in the repo)
// ---------------------------------------------------------------------------
const PATHWAY_COUNTRIES = [
  "AT","BE","BG","CH","CY","CZ","DE","DK","EE","EL",
  "ES","FI","FR","HK","HR","HU","IE","IT","LT","LU",
  "LV","MT","NL","NO","PL","PT","RO","SE","SI","SK","UK",
];

// HK has pathways but no emissions file
const EMISSION_COUNTRIES = PATHWAY_COUNTRIES.filter(c => c !== "HK");

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------
type PathwayEntry = { carbon_kgco2_m2yr: number; energy_kwh_m2yr: number };
type PathwayData = Record<string, Record<string, PathwayEntry>>;
type EmissionData = Record<string, number>;

// ---------------------------------------------------------------------------
// Interpolation helpers
// ---------------------------------------------------------------------------
function interpolate(data: Record<string, number>, year: number): number {
  const years = Object.keys(data).map(Number).sort((a, b) => a - b);
  if (year <= years[0]) return data[String(years[0])];
  if (year >= years[years.length - 1]) return data[String(years[years.length - 1])];
  const lo = years.filter(y => y <= year).pop()!;
  const hi = years.filter(y => y >= year).shift()!;
  if (lo === hi) return data[String(lo)];
  const t = (year - lo) / (hi - lo);
  return data[String(lo)] + t * (data[String(hi)] - data[String(lo)]);
}

function interpolateEntry(propData: Record<string, PathwayEntry>, year: number): PathwayEntry {
  const years = Object.keys(propData).map(Number).sort((a, b) => a - b);
  if (year <= years[0]) return propData[String(years[0])];
  if (year >= years[years.length - 1]) return propData[String(years[years.length - 1])];
  const lo = years.filter(y => y <= year).pop()!;
  const hi = years.filter(y => y >= year).shift()!;
  if (lo === hi) return propData[String(lo)];
  const t = (year - lo) / (hi - lo);
  const loE = propData[String(lo)];
  const hiE = propData[String(hi)];
  return {
    carbon_kgco2_m2yr: loE.carbon_kgco2_m2yr + t * (hiE.carbon_kgco2_m2yr - loE.carbon_kgco2_m2yr),
    energy_kwh_m2yr: loE.energy_kwh_m2yr + t * (hiE.energy_kwh_m2yr - loE.energy_kwh_m2yr),
  };
}

// ---------------------------------------------------------------------------
// Build a fresh MCP server instance with all tools registered
// ---------------------------------------------------------------------------
function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "crrem-mcp", version: "0.1.0" });

  // Tool 1: get_pathway
  server.tool(
    "get_pathway",
    "Carbon and energy pathway targets for a country/property type from CRREM v2.05",
    {
      country: z.string().describe("ISO-2 country code, e.g. DE, FR, UK"),
      propertyType: z.string().describe("Property type, e.g. office, residential_single-family"),
      year: z.number().optional().describe("Specific year 2020-2050 (optional; omit for full 2020-2050 pathway)"),
    },
    async ({ country, propertyType, year }) => {
      const code = country.toUpperCase();
      if (!PATHWAY_COUNTRIES.includes(code)) {
        return { content: [{ type: "text" as const, text: `Country ${code} not supported. Available: ${PATHWAY_COUNTRIES.join(", ")}` }], isError: true };
      }
      const data = await fetchData(`data/pathways/${code}.json`) as PathwayData;
      const propData = data[propertyType];
      if (!propData) {
        return { content: [{ type: "text" as const, text: `Property type "${propertyType}" not found. Available: ${Object.keys(data).join(", ")}` }], isError: true };
      }
      if (year !== undefined) {
        const entry = interpolateEntry(propData, year);
        return { content: [{ type: "text" as const, text: JSON.stringify({ country: code, propertyType, year, ...entry }) }] };
      }
      const allYears = [];
      for (let y = 2020; y <= 2050; y++) {
        allYears.push({ year: y, ...interpolateEntry(propData, y) });
      }
      return { content: [{ type: "text" as const, text: JSON.stringify({ country: code, propertyType, allYears }) }] };
    }
  );

  // Tool 2: get_emission_factors
  server.tool(
    "get_emission_factors",
    "Grid emission factors (kgCO2/kWh) for a country. CRREM v2.05 contains electricity factors only.",
    {
      country: z.string().describe("ISO-2 country code"),
      carrier: z.enum(["electricity","gas","oil","district_heating"]).describe("Energy carrier (only electricity has data)"),
      year: z.number().optional().describe("Specific year (optional; omit for all years 2020-2050)"),
    },
    async ({ country, carrier, year }) => {
      const code = country.toUpperCase();
      if (!EMISSION_COUNTRIES.includes(code)) {
        return { content: [{ type: "text" as const, text: `Country ${code} not supported. Available: ${EMISSION_COUNTRIES.join(", ")}` }], isError: true };
      }
      if (carrier !== "electricity") {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ country: code, carrier, note: "CRREM v2.05 only contains electricity emission factors. Gas/oil/district_heating are not available in this dataset." }),
          }],
        };
      }
      const data = await fetchData(`data/emissions/${code}.json`) as EmissionData;
      if (year !== undefined) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ country: code, carrier, year, factor_kgco2_kwh: interpolate(data, year) }) }] };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify({ country: code, carrier, factors: data }) }] };
    }
  );

  // Tool 3: get_climate_zone
  server.tool(
    "get_climate_zone",
    "Look up climate zone for a postal code. Supported: US (full ZIP), CA (first letter of FSA), AU (numeric prefix).",
    {
      postalCode: z.string().describe("Postal code, e.g. 90210 (US), M5V (CA), 2000 (AU)"),
      country: z.enum(["US","CA","AU"]).describe("Country"),
    },
    async ({ postalCode, country }) => {
      const code = postalCode.trim().toUpperCase();
      if (country === "US") {
        const firstDigit = code.replace(/\D/g, "")[0];
        if (!firstDigit) return { content: [{ type: "text" as const, text: "Invalid US ZIP code" }], isError: true };
        const data = await fetchData(`data/postal/US/${firstDigit}.json`) as Record<string, { climate_zone: string; region: string }>;
        const entry = data[code] ?? data[postalCode.trim()];
        if (!entry) return { content: [{ type: "text" as const, text: `ZIP code ${code} not found` }], isError: true };
        return { content: [{ type: "text" as const, text: JSON.stringify({ postalCode: code, country, climateZone: entry.climate_zone, region: entry.region }) }] };
      }
      if (country === "CA") {
        const data = await fetchData("data/postal/CA.json") as Record<string, { climate_zone: string; region: string }>;
        const entry = data[code[0]];
        if (!entry) return { content: [{ type: "text" as const, text: `CA postal prefix ${code[0]} not found` }], isError: true };
        return { content: [{ type: "text" as const, text: JSON.stringify({ postalCode: code, country, climateZone: entry.climate_zone, region: entry.region }) }] };
      }
      // AU: keyed by 3-digit numeric prefix
      const data = await fetchData("data/postal/AU.json") as Record<string, { climate_zone: string; region: string }>;
      const numeric = code.replace(/\D/g, "");
      let entry: { climate_zone: string; region: string } | undefined;
      for (let len = numeric.length; len >= 1; len--) {
        if (data[numeric.slice(0, len)]) { entry = data[numeric.slice(0, len)]; break; }
      }
      if (!entry) return { content: [{ type: "text" as const, text: `AU postal code ${code} not found` }], isError: true };
      return { content: [{ type: "text" as const, text: JSON.stringify({ postalCode: code, country, climateZone: entry.climate_zone }) }] };
    }
  );

  // Tool 4: calculate_stranding_risk
  server.tool(
    "calculate_stranding_risk",
    "Calculate CRREM stranding risk: compares a building's carbon intensity against the pathway target and finds the stranding year.",
    {
      currentIntensity: z.number().describe("Current carbon intensity in kgCO2/m²/yr"),
      country: z.string().describe("ISO-2 country code"),
      propertyType: z.string().describe("CRREM property type, e.g. office"),
      year: z.number().optional().describe("Reference year for 'now' (defaults to 2026)"),
    },
    async ({ currentIntensity, country, propertyType, year: refYear }) => {
      const code = country.toUpperCase();
      const currentYear = refYear ?? 2026;
      if (!PATHWAY_COUNTRIES.includes(code)) {
        return { content: [{ type: "text" as const, text: `Country ${code} not supported` }], isError: true };
      }
      const data = await fetchData(`data/pathways/${code}.json`) as PathwayData;
      const propData = data[propertyType];
      if (!propData) {
        return { content: [{ type: "text" as const, text: `Property type "${propertyType}" not found. Available: ${Object.keys(data).join(", ")}` }], isError: true };
      }

      const pathwayTarget = interpolateEntry(propData, currentYear).carbon_kgco2_m2yr;
      const gap = currentIntensity - pathwayTarget;
      const gapPercent = pathwayTarget > 0 ? (gap / pathwayTarget) * 100 : 0;

      // Find first year where pathway drops below current intensity
      let strandingYear: number | null = null;
      for (let y = currentYear; y <= 2050; y++) {
        if (interpolateEntry(propData, y).carbon_kgco2_m2yr < currentIntensity) {
          strandingYear = y;
          break;
        }
      }

      // Status logic:
      // - stranded: currentIntensity > pathwayTarget right now
      // - at-risk: currently on pathway but will strand before 2050
      // - on-pathway: on pathway and won't strand through 2050
      const isStranded = currentIntensity > pathwayTarget;
      let status: "on-pathway" | "at-risk" | "stranded";
      if (isStranded) status = "stranded";
      else if (strandingYear !== null && strandingYear > currentYear) status = "at-risk";
      else status = "on-pathway";

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            country: code,
            propertyType,
            year: currentYear,
            currentIntensity,
            pathwayTarget: Math.round(pathwayTarget * 1000) / 1000,
            gap: Math.round(gap * 1000) / 1000,
            gapPercent: Math.round(gapPercent * 10) / 10,
            strandingYear,
            isStranded,
            yearsToStranding: strandingYear !== null ? strandingYear - currentYear : null,
            status,
          }),
        }],
      };
    }
  );

  // Tool 5: list_countries
  server.tool(
    "list_countries",
    "List all countries with CRREM v2.05 pathway data available",
    {},
    async () => {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            pathway_countries: PATHWAY_COUNTRIES,
            emission_countries: EMISSION_COUNTRIES,
            postal_countries: ["US", "CA", "AU"],
            note: "EL=Greece, UK=United Kingdom (not GB), HK=Hong Kong. No US/CA/AU pathway or emission data in CRREM v2.05.",
          }),
        }],
      };
    }
  );

  // Tool 6: list_property_types
  server.tool(
    "list_property_types",
    "List available CRREM property types for a given country",
    { country: z.string().describe("ISO-2 country code") },
    async ({ country }) => {
      const code = country.toUpperCase();
      if (!PATHWAY_COUNTRIES.includes(code)) {
        return { content: [{ type: "text" as const, text: `Country ${code} not supported. Available: ${PATHWAY_COUNTRIES.join(", ")}` }], isError: true };
      }
      const data = await fetchData(`data/pathways/${code}.json`) as PathwayData;
      return { content: [{ type: "text" as const, text: JSON.stringify({ country: code, propertyTypes: Object.keys(data) }) }] };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT ?? "3000", 10);

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  // Health check
  if (url.pathname === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "crrem-mcp", version: "0.1.0" }));
    return;
  }

  // MCP endpoint — stateless: fresh server + transport per request
  if (url.pathname === "/mcp" && (req.method === "POST" || req.method === "GET" || req.method === "DELETE")) {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildMcpServer();
    await server.connect(transport);

    // Parse body for POST requests
    let body: unknown;
    if (req.method === "POST") {
      body = await new Promise((resolve, reject) => {
        let raw = "";
        req.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
        req.on("end", () => {
          try { resolve(JSON.parse(raw)); } catch { resolve(undefined); }
        });
        req.on("error", reject);
      });
    }

    await transport.handleRequest(req, res, body);
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

httpServer.listen(PORT, () => {
  console.log(`CRREM MCP server running on port ${PORT}`);
});
