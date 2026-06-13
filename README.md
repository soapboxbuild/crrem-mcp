# CRREM MCP Server

MCP server exposing CRREM v2.05 carbon pathway data for real estate decarbonization analysis.

## Endpoint

`POST /mcp` — MCP Streamable HTTP transport (stateless)  
`GET /health` — Health check

## Tools

| Tool | Description |
|---|---|
| `get_pathway` | Carbon & energy targets by country/property type/year |
| `get_emission_factors` | Grid emission factors by country |
| `get_climate_zone` | Climate zone for US/CA/AU postal codes |
| `calculate_stranding_risk` | Full stranding analysis for a building |
| `list_countries` | Available countries |
| `list_property_types` | Available property types for a country |

## Data notes

- **Countries**: EU-27 + CH + NO + UK + HK (CRREM v2.05). No US/CA/AU pathway data.
- **Country codes**: EL for Greece, UK for United Kingdom (not GB), HK for Hong Kong.
- **Emission factors**: Electricity only in CRREM v2.05 dataset.
- **Postal zones**: US (full ZIP), CA (first letter of FSA), AU (numeric prefix).
- **Interpolation**: Linear interpolation between data points for any year 2020–2050.
- **Data source**: `soapboxbuild/crrem-data` (public GitHub repo).

## Stranding status logic

- `stranded`: `currentIntensity > pathwayTarget` at the reference year
- `at-risk`: currently on pathway but will strand before 2050
- `on-pathway`: on pathway and won't strand through 2050

## Local dev

```bash
npm install
npm run dev       # tsx watch
npm run build     # tsc
node dist/index.js
```
