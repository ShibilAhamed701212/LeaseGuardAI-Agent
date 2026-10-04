<h1 align="center">LeaseGuardAI</h1>

<p align="center">
  <strong>AI-assisted vehicle lease contract analyser and negotiation coach</strong>
</p>

<p align="center">
  <a href="https://github.com/ShibilAhamed701212/LeaseGuardAI-Agent/actions/workflows/ci.yml"><img src="https://github.com/ShibilAhamed701212/LeaseGuardAI-Agent/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/Node.js-18%2B-green.svg" alt="Node 18+" />
  <img src="https://img.shields.io/badge/React-18-blue.svg" alt="React 18" />
</p>

LeaseGuardAI lets you upload a lease contract (PDF or image). A background worker sends the document to Google Gemini, which extracts the key financial terms (monthly payment, term, deposit, total cost, mileage, residual value, who pays maintenance/insurance/taxes, penalties) and rates financial and legal risk. The backend turns that into a fairness score and a list of issues to raise, the browser saves the result to IndexedDB, and a chat widget lets you ask follow-up questions about the contract.

---

## Screenshots

<p align="center">
  <img src="./assets/home_preview.png" width="49%" alt="Home page" />
  <img src="./assets/analyse_preview.png" width="49%" alt="Analyse page with the LeaseGuard Coach chat open" />
</p>

---

## Features

| Feature | What it actually does |
| --- | --- |
| Document upload | `POST /upload` accepts PDF, JPEG, PNG or WebP up to 20 MB and stores it in an S3-compatible bucket (MinIO, Supabase Storage, AWS S3). |
| Gemini extraction | The worker sends the file to `gemini-2.5-flash` as inline data and asks for a fixed JSON schema. Gemini reads scanned images and PDFs directly, so no separate OCR step runs on this path. |
| Alternative engines (API only) | `/process` also accepts `ai: "ollama"` or `ai: "custom"` (any OpenAI-compatible `/v1/chat/completions` endpoint). For these, text comes from `pdf-parse`, falling back to Gemini OCR for images and scanned PDFs. The web UI only offers Gemini. |
| Fairness score | Starts from the score Gemini returns (default 70), subtracts 15 for high financial risk, 10 for high legal risk, 5 each if the lessee pays maintenance or insurance, then clamps the result to 10–100 (`backend/functions/worker.ts`). |
| Negotiation tips | The issues Gemini detects plus its fairness explanation. |
| Local history | Results are saved in the browser's IndexedDB and listed on the History page. |
| LeaseGuard Coach | A floating chat widget (`POST /chat`) backed by Gemini, which is given the current result as context. |
| Self-healing jobs | Every 5 minutes, jobs stuck in `processing` for over 5 minutes are marked `failed` in PostgreSQL and Redis. |
| Diagnostics | `/health`, `/diagnostic` and `/debug/*` report dependency status, queue length, worker heartbeat and error patterns. Sentry is initialised on both client and server. |

---

## Architecture

```
Browser (React + Vite)
  Upload → poll /status → GET /result → save to IndexedDB → chat
        │ REST
        ▼
Backend (Express, backend/functions/index.ts)
  /upload  /process  /status  /result  /cleanup  /chat  /health  /debug
     │            │             │
     ▼            ▼             ▼
  S3/MinIO     PostgreSQL     Redis
  (uploaded    (job id,       (ocr:queue list, cached status,
   file)        status,        result JSON with 24h TTL,
                engines)       worker heartbeat)
                                │
                                ▼
                 Background worker (worker.ts, same process)
                 LPOP ocr:queue → download via signed URL →
                 Gemini (or pdf-parse + Ollama/custom) →
                 score → store result in Redis → mark completed
        │
        └─► n8n webhook (optional): the bundled workflow only validates,
            logs and acknowledges; the worker does all the processing.
```

### Job lifecycle

1. `POST /upload` stores the file at `uploads/<job_id>/file.<ext>` and inserts a `jobs` row with status `uploaded`.
2. `POST /process` checks the file exists, sets status `processing`, pushes the job onto `ocr:queue` and notifies n8n if `N8N_WEBHOOK_URL` is set.
3. The worker polls the queue every 3 s and handles one job at a time, setting the Redis status to `reading_document`, then `analyzing_contract`, then `completed` or `failed`.
4. `GET /status/:job_id` reads Redis first and falls back to PostgreSQL.
5. `GET /result/:job_id` returns the result from Redis. Results expire after `REDIS_RESULT_TTL_SECONDS` (default 24 h).
6. `DELETE /cleanup/:job_id` deletes the stored file and Redis keys and marks the job `deleted`.

---

## Project structure

```
LeaseGuardAI-Agent/
├── backend/                  Express API + background worker (deployed to Render)
│   ├── functions/
│   │   ├── index.ts          Entry point, health/diagnostic routes, startup
│   │   ├── worker.ts         Queue processor (Gemini / Ollama / custom)
│   │   ├── upload/ process/ status/ result/ cleanup/ chat/
│   │   ├── debug.ts          /debug routes
│   │   └── utils/            postgres, redis, S3, n8n clients, logger, error handler, file types
│   └── tests/                Unit tests (node:test)
├── frontend/                 React 18 + Vite SPA (deployed to Firebase Hosting)
│   └── src/
│       ├── pages/            Home, Upload, Result, History
│       ├── components/       upload, result, history, chat, shared
│       ├── hooks/            useUpload, useProcess, useResult
│       └── services/         api.ts, IndexedDB storage
├── services/                 Optional, not used by the backend's processing path
│   ├── ai/                   Standalone AI microservice (Ollama / OpenAI / Anthropic)
│   ├── ocr/tesseract/        Python Tesseract OCR service
│   ├── ocr/paddle/           Python PaddleOCR service
│   └── shared/               Scoring/normalisation helpers (not imported by backend or frontend)
├── infra/
│   ├── docker/               docker-compose stack + setup scripts
│   └── postgres/init.sql     jobs table, n8n schema, updated_at trigger
├── n8n/workflows/            n8n workflow export
├── render.yaml               Render blueprint for the backend
└── firebase.json             Firebase Hosting config for frontend/dist
```

---

## Tech stack

- **Backend:** Node.js 18+, Express 4, TypeScript 5 bundled with esbuild, `pg`, `ioredis`, AWS SDK v3 S3 client, `busboy`, `@google/generative-ai`, `pdf-parse`, Sentry.
- **Frontend:** React 18, React Router 6, Vite 5, TypeScript 5, IndexedDB, Sentry.
- **Infrastructure:** PostgreSQL 16, Redis 7, MinIO, n8n, Ollama (docker-compose); Render and Firebase Hosting for deployment.

---

## Getting started

### Prerequisites

- Node.js 18 or 20
- Docker with Docker Compose (for the local PostgreSQL, Redis and MinIO)
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/app/apikey)

### 1. Start the infrastructure

The backend needs only PostgreSQL, Redis and MinIO:

```bash
cd infra/docker
cp .env.example .env
docker compose up -d postgres redis minio
```

`setup.sh` / `setup.ps1` bring up the full stack instead, including n8n, Ollama (which requests an NVIDIA GPU) and the optional OCR/AI services. MinIO's console is at http://localhost:9001; the backend creates the bucket on startup if it is missing.

### 2. Run the backend

```bash
cd backend
cp .env.example .env      # set GEMINI_API_KEY; defaults match the docker-compose ports
npm install
npm run dev               # builds lib/index.js and starts on http://localhost:10000
```

If PostgreSQL or the bucket is unreachable at startup, the server still listens in a degraded "diagnostic mode" so `/health` can report what is wrong.

### 3. Run the frontend

```bash
cd frontend
cp .env.example .env      # set VITE_API_BASE_URL=http://localhost:10000
npm install
npm run dev               # http://localhost:5173
```

### 4. (Optional) n8n

Import `n8n/workflows/ocr_pipeline.json` at http://localhost:5678 and set `N8N_WEBHOOK_URL` in `backend/.env`. Processing works without it.

---

## Configuration

### Backend (`backend/.env`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `10000` | HTTP port |
| `PG_HOST`, `PG_PORT`, `PG_DATABASE`, `PG_USER`, `PG_PASSWORD` | `localhost`, `5432`, `ocr_agent` | PostgreSQL connection (docker-compose maps it to host port 5433) |
| `PG_SSL` | `false` | Use TLS for PostgreSQL |
| `REDIS_URL` | — | Full Redis URL; takes precedence over host/port. `rediss://` enables TLS |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_TLS` | `localhost`, `6379` | Redis connection (docker-compose maps it to host port 6380) |
| `MINIO_ENDPOINT`, `MINIO_PORT`, `MINIO_USE_SSL` | — | S3-compatible endpoint. HTTPS unless `MINIO_USE_SSL=false` |
| `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_BUCKET` | bucket `ocr-agent` | S3 credentials and bucket |
| `SIGNED_URL_EXPIRY_SECONDS` | `3600` | Lifetime of the signed URL the worker downloads from |
| `REDIS_RESULT_TTL_SECONDS` | `86400` | TTL of cached results and statuses |
| `GEMINI_API_KEY` | — | Required for Gemini analysis, Gemini OCR fallback and `/chat` |
| `OLLAMA_HOST` | `localhost` | Hostname only; the worker calls `http://<OLLAMA_HOST>:11434` |
| `N8N_WEBHOOK_URL`, `N8N_SECRET` | — | Optional n8n notification |
| `DEBUG_FILE`, `LOG_DIR` | `false`, `./logs` | Write structured logs to files (read back by `/debug/logs`) |

### Frontend (`frontend/.env`)

| Variable | Purpose |
| --- | --- |
| `VITE_API_BASE_URL` | Backend base URL. `.env.production` holds the deployed Render URL used by `npm run build`. |

Never commit real `.env` files; they are git-ignored, and only the `.env.example` templates are tracked.

---

## API reference

| Method | Endpoint | Body | Response |
| --- | --- | --- | --- |
| `POST` | `/upload` | `multipart/form-data` with `file` and `user_id` | `{ job_id, status: "uploaded" }` |
| `POST` | `/process` | `{ job_id, ocr: "google_cloud", ai: "gemini" \| "ollama" \| "custom", config?: { apiKey, baseUrl, modelName } }` | `{ job_id, status: "processing" }`; 404 unknown job, 409 already processing, 410 deleted |
| `GET` | `/status/:job_id` | — | `{ job_id, status }` with status `uploaded`, `processing`, `reading_document`, `analyzing_contract`, `completed`, `failed` or `deleted` |
| `GET` | `/result/:job_id` | — | `{ job_id, status: "completed", data: { sla, vin, price_estimate, fairness_score, negotiation_tips } }`; 202 still running, 422 failed, 410 deleted, 404 expired |
| `DELETE` | `/cleanup/:job_id` | — | `{ job_id, status: "deleted", warnings? }` |
| `POST` | `/chat` | `{ message, history?: [{ role, content }], contract_context? }` | `{ reply, tokens_used }` (`tokens_used` is the reply's character count, not a token count) |
| `GET` | `/health` | — | Overall `ok`/`degraded` plus per-service status for PostgreSQL, Redis and storage |
| `GET` | `/diagnostic`, `/debug`, `/debug/logs`, `/debug/health`, `/debug/predictions`, `/debug/errors` | — | Diagnostics (see Known limitations) |

`vin` is always `null` at present, and `sla.apr` is always `null` because the current prompt does not extract APR.

---

## Testing

```bash
cd backend
npm run typecheck   # tsc --noEmit
npm test            # unit tests in backend/tests (node:test)
npm run build       # esbuild bundle

cd ../frontend
npm run build       # tsc + vite build
```

CI (`.github/workflows/ci.yml`) runs these on every push and pull request to `main`, and validates both docker-compose files. The unit tests cover upload file-type handling; there are no end-to-end tests yet.

---

## Deployment

- **Backend → Render:** `render.yaml` defines a Node web service rooted at `backend/` (`npm install && npm run build`, then `npm start`, health check `/health`). Set the `sync: false` variables in the Render dashboard. On pushes to `main`, CI calls `RENDER_DEPLOY_HOOK_URL` if that secret is set.
- **Frontend → Firebase Hosting:** `firebase.json` serves `frontend/dist` with SPA rewrites. On pushes to `main`, CI deploys if the `FIREBASE_SERVICE_ACCOUNT` secret is set. To deploy by hand: `cd frontend && npm run build && cd .. && firebase deploy --only hosting`.

---

## Data handling

- PostgreSQL stores only job metadata (id, status, engines, timestamps).
- Results and statuses live in Redis with a TTL (24 h by default).
- Uploaded files stay in the bucket until `DELETE /cleanup/:job_id` is called. The frontend does not call it, and no bucket lifecycle rule is configured, so add a lifecycle rule on the bucket if files should expire automatically.
- Contract contents are sent to Google Gemini (or to the Ollama/custom endpoint you choose) for analysis.
- Full results are also saved in the browser's IndexedDB.

---

## Known limitations

- **No authentication or rate limiting.** Anyone who can reach the API can upload, process and use `/chat`, which spends the server's Gemini quota. Job ids are random UUIDs, which is the only protection on `/status`, `/result` and `/cleanup`.
- **Diagnostic endpoints are public.** `/health` shows partial hostnames and the database user; `/debug/*` shows queue and error details, and `/debug/logs` returns log entries when `DEBUG_FILE=true`.
- **User-supplied endpoints.** With `ai: "ollama"` or `ai: "custom"`, the server makes requests to whatever `config.baseUrl` the client sends. Restrict or remove this if the API is exposed publicly.
- **Single worker.** Jobs run one at a time inside the API process, so a slow job delays the queue.
- **Unused components.** `services/ai`, `services/ocr/*` and `services/shared` are not wired into the backend's processing path, and the UI exposes only Gemini.
- CORS allows all origins.

---

## Contributing

1. Create a branch from `main`.
2. Run the commands in [Testing](#testing).
3. Open a pull request against `main`.

See [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
