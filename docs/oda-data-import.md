# ODA Data Import

## Source

Statistics Canada [Open Database of Addresses (ODA)](https://www.statcan.gc.ca/en/lode/databases/oda), version 1.0 (2021001), Open Government License - Canada.

Data collection period: January–April 2021. New developments after 2021 may be missing.

## Province downloads

Base URL: `https://www150.statcan.gc.ca/n1/en/pub/46-26-0001/2021001/`

| Province | File |
|----------|------|
| Ontario | `ODA_ON_v1.zip` |
| Quebec | `ODA_QC_v1.zip` |
| Alberta | `ODA_AB_v1.zip` |
| British Columbia | `ODA_BC_v1.zip` |
| Manitoba | `ODA_MB_v1.zip` |
| New Brunswick | `ODA_NB_v1.zip` |
| Northwest Territories | `ODA_NT_v1.zip` |
| Nova Scotia | `ODA_NS_v1.zip` |
| Prince Edward Island | `ODA_PE_v1.zip` |
| Saskatchewan | `ODA_SK_v1.zip` |

Initial deployment imports **ON** and **QC** only.

## ODA CSV columns used

| ODA column | Schema field |
|------------|--------------|
| Civic Number | `civic_number` |
| Standardized Street Name | `street_name` |
| Standardized Street Type | `street_type` |
| Standardized Street Direction | `street_direction` |
| Unit | `unit` |
| Postal Code | `postal_code` |
| Processed City | `city` |
| Province or Territory Unique Identifier | `province` |
| Latitude | `lat` |
| Longitude | `lon` |
| Full Address | `full_address` |

Rows without valid coordinates are skipped.

## Import pipeline

```bash
# 1. Create D1 database (once)
wrangler d1 create oda-addresses

# 2. Add ODA_DB binding to wrangler.jsonc (see README)

# 3. Initialize schema (via API or import script)
curl -X POST https://your-worker.workers.dev/api/oda/init \
  -H "Authorization: Basic ..."

# 4. Run import

# Download Ontario from StatCan and import to production D1
CLOUDFLARE_ACCOUNT_ID=your-account-id \
npm run import:oda -- --download --provinces ON --remote --skip-schema

# Fixture / local CSV
npm run import:oda -- --provinces ON,QC --file test/fixtures/oda/fixture.csv --remote --skip-schema

# Pilot import (first N rows only)
npm run import:oda -- --download --provinces ON --remote --skip-schema --max-rows 10000

# Resume after interruption (skips rows already in D1 for each province)
npm run import:oda -- --download --provinces ON --remote --skip-schema --resume

# 5. Verify stats
curl https://your-worker.workers.dev/api/oda/stats \
  -H "Authorization: Basic ..."
```

## Import script options

`scripts/import-oda.ts` is invoked via `npm run import:oda -- [options]`.

| Flag | Description |
|------|-------------|
| `--download` | Download and unzip province CSV from StatCan (`ODA_{PR}_v1.zip`) |
| `--provinces ON,QC` | Provinces to import (default: `ON,QC`) |
| `--file path.csv` | Local CSV instead of download |
| `--remote` | Write to remote D1 (omit for `--local` dev database) |
| `--local` | Implicit when `--remote` is omitted |
| `--database name` | D1 database name (default: `oda-addresses`) |
| `--skip-schema` | Skip table creation (use after `/api/oda/init` or first run) |
| `--batch-size N` | Rows per D1 upload batch (default: 500) |
| `--max-rows N` | Stop after N address rows (pilot imports) |
| `--resume` | Skip rows already present in D1; does not delete existing province data |
| `--output-dir dir` | Download/extract/SQL staging dir (default: `.oda-import`) |

The import script:

1. Downloads and unzips province CSV when `--download` is set (StatCan `ODA_{PR}_v1.zip`)
2. Streams rows from CSV (supports `--max-rows` for pilots)
3. Normalizes rows via `src/oda-normalize.ts` (fixture and StatCan column layouts)
4. Builds Canada Post-style mailing fields
5. Batch inserts into D1 with retry on upload failures (`--batch-size`, default 500)
6. Computes postal/city centroids and street ranges
7. Records import metadata in `oda_imports`

Ontario (`ODA_ON_v1.csv`) is ~690 MB uncompressed (~6M addresses). Full import takes several hours over `--remote`. Use `--resume` if a long import is interrupted.

## D1 scale check

Before full ON+QC import, run a fixture import and verify:

- Storage limits for your Cloudflare account
- Write throughput (batch size tuning)
- Query latency for exact, postal, city, and nearest-neighbor lookups

If D1 cannot hold the full address table:

- D1 stores centroids, street ranges, and compact search indexes
- Full rows live in R2 shards by province/city/postal
- Runtime exact lookup fetches the appropriate shard

## Re-import

Without `--resume`, re-running import for a province deletes existing rows for that province and re-imports. Import metadata is preserved in `oda_imports`.

With `--resume`, existing rows are kept and the CSV stream skips the number of rows already stored for that province.
