# Menjalankan LinkedERP AI

Panduan praktis buat menghidupkan stack di mesin lokal. Latar belakang arsitektur
ada di [README.md](README.md); file ini cuma langkah-langkah menjalankan.

## Yang dibutuhkan

| Kebutuhan | Catatan |
| --- | --- |
| Node.js 20+ | `node -v` |
| PostgreSQL 14+ | bisa lokal atau remote, yang penting `DATABASE_URL` sampai |
| Redis | opsional — kalau `redis-server` nggak ada, `dev-up.sh` build sendiri ke `~/.local` |
| C toolchain + koneksi internet | hanya kalau Redis perlu di-build |

Tanpa root. Tanpa Docker (kecuali kamu pilih jalur Docker di bawah).

---

## Jalur cepat (tanpa Docker) — yang dipakai di host ini

```bash
# 1. Siapkan database sekali saja
sudo -u postgres createuser -P linkederp        # isi password, mis. linkederp_dev
sudo -u postgres createdb -O linkederp linkederp_ai

# 2. Bikin .env dengan secret baru
./infrastructure/scripts/bootstrap-env.sh
# lalu edit DATABASE_URL di .env supaya cocok dengan langkah 1:
#   DATABASE_URL=postgresql://linkederp:linkederp_dev@127.0.0.1:5432/linkederp_ai

# 3. Install dependency
npm install

# 4. Nyalakan semuanya (build + migrate + start)
npm run dev        # sama dengan ./infrastructure/scripts/dev-up.sh
```

`dev-up.sh` idempoten — kalau service-nya sudah hidup dia bilang "already running"
dan lanjut, jadi aman dijalankan berulang.

### Alamat

| Service | URL |
| --- | --- |
| Portal | http://localhost:3000 |
| API | http://localhost:4000/api/v1 |
| Health | http://localhost:4000/api/v1/health |
| Readiness | http://localhost:4000/api/v1/health/ready |
| WebSocket | ws://localhost:4000/ws |

### Cek stack benar hidup

```bash
curl -s http://127.0.0.1:4000/api/v1/health/ready
# {"status":"ready","checks":{"postgres":"up","redis":"up"}}

curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000
# 200
```

### Berhenti

```bash
npm run dev:stop   # sama dengan ./infrastructure/scripts/dev-down.sh
```

`dev-down.sh` membunuh per *process group* dan memberi grace 35 detik (worker
BullMQ butuh segitu buat menutup blocking read). Kalau ada port yang masih
dipegang orphan, dia lapor pid-nya.

---

## Jalur Docker

Perlu Docker dengan Compose v2.

```bash
cp .env.example .env
# isi JWT_SECRET dan SECRETS_ROOT_KEY: openssl rand -hex 32
# isi POSTGRES_PASSWORD
npm run compose:up          # docker compose up -d --build
```

Semuanya lewat reverse proxy di **http://localhost:8080** (portal, API, dan WS).
Matikan dengan `npm run compose:down`.

Jalur ini ditulis tapi belum pernah dieksekusi di host foundation — lihat ADR-012.

---

## Mode development (hot reload)

`npm run dev` menjalankan build produksi. Kalau lagi ngoding dan mau reload
otomatis, jalankan per proses di terminal terpisah (Redis dan Postgres tetap
harus hidup duluan):

```bash
npm run dev:api        # NestJS --watch
npm run dev:worker     # worker agent --watch
npm run dev:frontend   # next dev
```

---

## Coba jalan

Bikin akun lalu pakai token-nya:

```bash
TOKEN=$(curl -s -X POST http://127.0.0.1:4000/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"SmokeTest123!","name":"You","organizationName":"Org"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).accessToken')

curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4000/api/v1/projects
```

Atau lewat portal: buka http://localhost:3000/register, daftar, lalu
Dashboard → Projects → New.

Tanpa `AI_API_KEY` platform memakai **scripted provider** — loop dan tool yang
sama, tanpa panggilan jaringan. Semua plan-nya menyatakan bahwa itu bukan
karangan model.

---

## Log dan state

Semuanya di `.runtime/` (git-ignored):

```
.runtime/api.log        .runtime/api.pid
.runtime/worker.log     .runtime/worker.pid
.runtime/frontend.log   .runtime/frontend.pid
.runtime/redis.log      .runtime/redis.pid
.runtime/workspaces/    clone per-task, dihapus bareng run-nya
```

```bash
tail -f .runtime/api.log
tail -f .runtime/worker.log     # progres agent kelihatan di sini
```

---

## Verifikasi

```bash
npm run typecheck                                    # backend + frontend
npm test                                             # unit test backend
./infrastructure/scripts/smoke-test.sh               # API dan workflow
./infrastructure/scripts/smoke-test-repository.sh    # repository agent
./infrastructure/scripts/smoke-test-agent.sh         # model layer + AI boundary
./infrastructure/scripts/smoke-test-safety.sh        # push refusal + environment
```

Detail cakupan tiap skrip ada di README bagian 4.

---

## Kalau macet

| Gejala | Penyebab dan tindakan |
| --- | --- |
| `readiness` bilang `postgres: down` | `DATABASE_URL` salah, atau Postgres mati. Cek `pg_isready -h 127.0.0.1 -p 5432` |
| `readiness` bilang `redis: down` | `redis-cli -p 6379 ping` harus balas `PONG`. `dev-up.sh` bakal build Redis lokal kalau belum ada |
| Port 3000/4000 sudah dipakai | `dev-down.sh` melaporkan pid pemegang port. Kill manual, lalu `dev-up.sh` lagi |
| Migrasi gagal | User Postgres harus punya hak pada database-nya. `npm run db:migrate` untuk jalankan ulang sendiri |
| Frontend error page rusak | Build harus jalan dengan `NODE_ENV=production`. Hapus `frontend/.next`, lalu `./infrastructure/scripts/build.sh` |
| `bootstrap-env.sh` bilang sudah ada | Sengaja — kehilangan `SECRETS_ROOT_KEY` bikin semua kredensial project nggak bisa dibuka lagi (ADR-014). Edit `.env` manual |

---

## Batasan yang memang disengaja

- **`git push` ditolak.** `GIT_PUSH_ENABLED` default false, dan penolakannya ada
  di process layer — bukan di tool, jadi nggak ada permission atau approval yang
  bisa membukanya. Buktikan: `node infrastructure/scripts/probe-push-refusal.js`.
- **Environment `production` ditolak** sebelum satu baris pun ditulis (ADR-021).
- **Validasi (lint/test) masih disimulasikan** — menjalankan kode repo asing
  adalah alasan batas microVM itu ada (ADR-013, ADR-019).
