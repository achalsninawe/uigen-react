# Spec2UI

Upload your specs — user flows, API docs, OpenAPI/Swagger, PDF, Word — and get a
real React app wired to the endpoints those documents describe.

The endpoints are taken **exactly as written**. Nothing is invented.

---

## Quick start

```bash
cd "D:\UI GEN"
npm install     # first time only
npm run dev
```

Then open **http://localhost:5173**

That starts both halves:

| | | |
|---|---|---|
| web | http://localhost:5173 | the studio you interact with |
| api | http://localhost:5177 | upload, analysis, generation, proxy |

Press `Ctrl+C` in the terminal to stop both.

### Check it came up correctly

Open http://localhost:5177/api/health — you want:

```json
{ "ok": true, "ai": "ready", "storage": "azure" }
```

- `"ai": "ready"` — Azure OpenAI is connected
- `"ai": "mock"` — no valid key; OpenAPI files still work, but prose documents
  and screen generation are disabled
- `"storage": "azure"` — using your storage account
- `"storage": "local"` — no connection string; falling back to `.work/storage`

---

## Configuration

Everything lives in `.env` at the repo root. Copy `.env.example` if you need a
fresh one.

```ini
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_ENDPOINT=https://dynamic-ui-and-video.openai.azure.com/
AZURE_OPENAI_DEPLOYMENT=gpt-4o
AZURE_OPENAI_API_VERSION=2024-12-01-preview

# A second deployment, kept alongside the first
AZURE_V2_API_KEY=...
AZURE_V2_ENDPOINT=...
AZURE_V2_DEPLOYMENT=gpt-5.5
AZURE_V2_API_VERSION=2024-12-01-preview

# Which of the two to use: v1, v2, or either deployment name
AZURE_MODEL=v1

AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=...
AZURE_STORAGE_PREFIX=spec2ui

PORT=5177
WORK_DIR=./.work
RUNNER_PORT_START=5310
RUNNER_PORT_END=5360
```

`.env` is git-ignored. **The server reads it at startup only** — after editing it,
stop and restart `npm run dev`.

---

## How it works

```
  your documents
        │
        ▼
  ┌───────────┐   OpenAPI / Swagger ──────────────┐  read structurally,
  │   PARSE   │   md · txt · pdf · docx ──┐        │  no model involved
  └───────────┘                           │        │
        │                                 ▼        ▼
        ▼                          ┌─────────────────────┐
  ┌───────────┐                    │      ANALYZE        │
  │  ANALYZE  │◀── the model reads │  endpoints · types  │
  └───────────┘    the prose docs  │  flows · gaps       │
        │                          └─────────────────────┘
        ▼
   ┌─────────┐   you review and correct the extraction here
   │ INSPECT │   before a single line of code is written
   └─────────┘
        │
        ▼
  ┌───────────┐  api.ts · types.ts · UI kit · shell
  │   EMIT    │  written by CODE, never by the model
  └───────────┘
        │
        ▼
  ┌───────────┐  the model writes ONLY src/screens/*.tsx,
  │  CODEGEN  │  composing from the emitted client and kit
  └───────────┘
        │
        ▼
  ┌───────────┐  parse · grounding · imports
  │ VALIDATE  │  violations go back for repair, up to 2 rounds
  └───────────┘
```

### Why the endpoints are trustworthy

This is the part worth understanding, because it is what separates this from
asking a chatbot to write you a UI.

**The model never writes a URL.** `src/lib/api.ts` in the generated app is
produced by code, straight from the extracted endpoint list:

```ts
export async function getOrder(orderId: string, options?: RequestOptions): Promise<Order> {
  return call<Order>({
    operationId: "getOrder",
    method: "GET",
    path: "/orders/{orderId}",                  // ← copied from your spec
    baseUrl: "https://api.acme-orders.com/v2",  // ← copied from your spec
    pathParams: { orderId },
    auth: { type: "bearer", name: "Authorization", scheme: "Bearer" },
  }, options)
}
```

The model's only job is writing screens that call `getOrder(id)`. It is never
handed a URL, so it cannot get one wrong.

**A validator enforces this mechanically.** Any generated screen is rejected if
it contains `fetch(`, `axios`, `XMLHttpRequest`, a hard-coded `http(s)://`
literal, or an import of an API function that is not in your spec. Rejected
screens are sent back for repair, not shipped.

**Gaps are reported, not filled.** When your documents leave something open — no
base URL, an undescribed error shape, a flow step with no matching endpoint —
it appears in a gaps list instead of being quietly invented.

---

## Where things are stored

Nothing important lives on your disk. Your Azure Storage account holds it all:

| Container | Contents |
|---|---|
| `spec2ui-specs` | the original files you uploaded |
| `spec2ui-artifacts` | `project.json` — extraction, plan, settings |
| `spec2ui-generated` | every generated file, one blob each |
| `spec2ui-exports` | downloadable ZIPs |
| Table `spec2uiprojects` | project index, for fast listing |

They are created automatically on first use.

`.work/` is local scratch space only — safe to delete at any time.

---

## Project layout

```
D:\UI GEN\
├─ .env                  credentials and ports
├─ server/               Express 5 + TypeScript
│  ├─ src/
│  │  ├─ routes/         projects · analyze · generate
│  │  ├─ services/
│  │  │  ├─ parsers/     md · pdf · docx · OpenAPI extraction
│  │  │  ├─ emit/        the code generators (api client, types, UI kit, shell)
│  │  │  ├─ pipeline/    analyze · generate · validate
│  │  │  ├─ blobs.ts     Azure Blob + Table, local fallback
│  │  │  └─ azure.ts     Azure OpenAI client
│  │  └─ prompts/        analyze · plan · codegen
│  └─ scripts/
└─ web/                  React 19 + Vite + Tailwind v4
   └─ src/
      ├─ components/     design system, dropzone
      ├─ pages/
      └─ lib/
```

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | start both servers (this is the one you want) |
| `npm run dev:server` | API only, on :5177 |
| `npm run dev:web` | studio only, on :5173 |
| `npm run typecheck` | type-check both packages |
| `npm run build` | production build of both |
| `npm run verify:emit -w server -- <projectId>` | emit a project to `.work/verify/` so you can compile it yourself |

---

## Troubleshooting

**`http proxy error: /api/... ECONNREFUSED`** — the web server is up but the API
server is not. Check the terminal for a `spec2ui server http://localhost:5177`
banner; if it never appeared, the server failed to start. Run it alone to see
the error:

```bash
npm run dev:server
```

**`Port 5173 is already in use`** — a previous run is still alive. The dev server
now fails loudly rather than quietly moving to 5174, so the URL it prints always
matches this README. Kill the old process (below) and start again.

**Port already in use** — an old run is still alive. On Windows:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*UI GEN*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

**`"ai": "mock"` after adding the key** — the server only reads `.env` at
startup. Restart `npm run dev`.

**A PDF produced no text** — it is probably scanned images. There is no OCR;
export a text-based PDF or paste the content into a `.md` file.

**Generation is slow** — screens are generated one at a time on purpose, to stay
well inside your deployment's rate limit. A 6-screen app takes a couple of
minutes.
