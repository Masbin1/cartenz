# Panduan Penggunaan: Membuat dan Menjalankan Project Odoo di Cartenz

Dokumen ini menjelaskan cara membuat project Odoo di Cartenz dan menjalankannya
secara lokal, dari sisi pengguna. Mencakup fitur yang diperkenalkan oleh
ADR-032 sampai ADR-038.

Ringkasan alur:

1. Buat project (dua cara: "Create with AI" atau "Connect / on-premise").
2. Cartenz meng-scaffold sebuah direktori git di server, lengkap dengan
   `odoo.conf`, `run.sh`, dua environment (Development + Staging), dan tiga
   branch (`main`, `staging`, `development`).
3. Jalankan project secara lokal dengan `./run.sh` — tanpa Docker.
4. Beri tugas ke agent (`change` atau `chat`); tugas dijalankan pada branch
   environment yang dituju.

---

## 1. Konsep Dasar

### 1.1 Tipe project

| Tipe | Sumber kode | Di-scaffold? |
|---|---|---|
| `ai_project` | Lokal (Create with AI) | Ya — selalu |
| `on_premise` | Lokal | Ya — bila opsi scaffold aktif |
| `repository` | Git remote | Tidak — kode dari remote |
| `odoo_sh` | Odoo.sh (git remote) | Tidak — kode dari remote |
| `odoo_online` | Instance Odoo Online (JSON-RPC) | Tidak — tanpa filesystem |

Panduan ini berfokus pada tipe yang di-scaffold (`ai_project` dan `on_premise`),
karena itulah yang menghasilkan direktori lokal yang bisa langsung dijalankan.

### 1.2 Lokasi project

Project yang di-scaffold ditaruh di **projects root** organisasi:

```
<projects_root>/<nama_teknis>/
```

- `projects_root` diatur di portal (Settings organisasi) atau `ON_PREMISE_ROOT`
  di server. Pada dev box saat ini: `/home/masbintang/linkederp/projects`.
- `<nama_teknis>` diturunkan dari nama project: huruf kecil, spasi/tanda baca
  jadi underscore. Contoh: "PT Angin Ribut" → `pt_angin_ribut`.

Catatan penting: project **tidak** disimpan di dalam repo Cartenz
(`cartenz_project`). Ia ditaruh terpisah di projects root. Kalau membuka lewat
Windows Explorer di WSL: `\\wsl.localhost\<distro>\home\masbintang\linkederp\projects`.

### 1.3 Odoo edition (ADR-037)

Saat membuat project dipilih **Community** atau **Enterprise**:

- **Enterprise** (default): `odoo.conf` memuat base + enterprise; agent boleh
  membaca source enterprise sebagai referensi.
- **Community**: `odoo.conf` hanya base (tanpa enterprise); agent **tidak** boleh
  membaca source enterprise.

### 1.4 Environment dan branch (ADR-038, ADR-021)

Setiap environment = sebuah branch git. Project scaffold otomatis mendapat:

| Environment | Branch | Kind | Default target |
|---|---|---|---|
| Development | `development` | development | Ya |
| Staging | `staging` | staging | Tidak |

Plus branch `main` sebagai basis. Production tidak pernah dibuat sebagai target
otomatis (aman: tugas menolak menarget production).

---

## 2. Membuat Project

### 2.1 Cara A — Create with AI (portal)

Menu: **Projects → New → Create with AI**.

Isian:

1. **Project name** — nama tampilan (mis. "Equipment Management").
2. **Odoo version** — 15.0 … 19.0.
3. **Odoo edition** — Community atau Enterprise.
4. **Description** — deskripsi singkat (wajib).
5. **Requirements** — minimal satu; menjadi spesifikasi terstruktur yang
   dijadikan acuan agent.

Setelah submit, Cartenz:

- membuat direktori `<projects_root>/<nama_teknis>/`,
- menulis `addons/` (kosong), `odoo.conf`, `run.sh`, `.gitignore`, `README.md`,
- init git dengan branch `main`, commit awal, lalu buat branch `staging` dan
  `development`,
- membuat environment Development + Staging,
- menyimpan spesifikasi.

### 2.2 Cara B — Connect / on-premise (portal)

Menu: **Projects → New**. Pilih tipe **On-premise**, lalu:

- **Odoo version** dan **Odoo edition** seperti di atas.
- Bila memilih untuk scaffold direktori baru: Cartenz membuat struktur yang sama
  seperti Cara A.
- Environment: bila tidak mengisi environment sendiri, otomatis dapat
  Development + Staging. Bila mengisi environment sendiri, isian dihormati dan
  branch dibuatkan untuk masing-masing.

### 2.3 Cara C — API langsung

Create with AI:

```bash
curl -X POST http://127.0.0.1:4000/api/v1/projects/ai \
  -H "Authorization: Bearer <TOKEN>" \
  -H 'Content-Type: application/json' \
  -d '{
    "organizationId": "<ORG_ID>",
    "name": "Equipment Management",
    "odooVersion": "19.0",
    "odooEdition": "community",
    "description": "Modul manajemen aset.",
    "requirements": [{"title": "Aset", "detail": "Lacak aset per departemen"}]
  }'
```

`odooEdition` opsional; bila diabaikan berarti `enterprise`.

Respons memuat `environmentConfig.onPremisePath` — itu lokasi direktori project.

Connect / on-premise:

```bash
curl -X POST http://127.0.0.1:4000/api/v1/projects \
  -H "Authorization: Bearer <TOKEN>" \
  -H 'Content-Type: application/json' \
  -d '{
    "organizationId": "<ORG_ID>",
    "name": "PT Angin Ribut",
    "projectType": "on_premise",
    "odooVersion": "19.0",
    "odooEdition": "enterprise",
    "scaffold": true
  }'
```

---

## 3. Struktur Project yang Dihasilkan

```
<projects_root>/<nama_teknis>/
├── .git/                 branch: main, staging, development (HEAD di main)
├── .gitignore            __pycache__, *.pyc, .idea, .vscode
├── README.md             deskripsi + cara menjalankan
├── odoo.conf             konfigurasi server (per-project, boleh diedit)
├── run.sh                launcher (executable)
└── addons/
    └── .gitkeep          modul kustom ditaruh di sini
```

Isi `odoo.conf` (contoh Enterprise):

```ini
[options]
addons_path = /home/masbintang/linkederp/base/odoo/addons,/home/masbintang/linkederp/base/enterprise,addons
db_name = <nama_teknis>
db_host = 127.0.0.1
db_port = 5432
db_user = odoo
http_interface = 127.0.0.1
http_port = 8069
```

Untuk **Community**, baris `addons_path` tidak memuat path enterprise:

```ini
addons_path = /home/masbintang/linkederp/base/odoo/addons,addons
```

Catatan:
- `addons` (entri terakhir) ditulis relatif terhadap folder conf, sehingga
  clone yang dipindah tetap menemukan modulnya.
- Password tidak disimpan di file; `run.sh` mengoper `PGPASSWORD`.

---

## 4. Menjalankan Project Secara Lokal (tanpa Docker)

Dari dalam direktori project:

```bash
cd <projects_root>/<nama_teknis>

# Sekali di awal: inisialisasi database
./run.sh -i base --stop-after-init

# Menjalankan server
./run.sh
```

Lalu buka `http://127.0.0.1:8069`.

`run.sh` meneruskan argumen tambahan ke `odoo-bin`, jadi:

```bash
./run.sh -u <nama_modul>          # update modul
./run.sh -i <nama_modul>          # install modul
./run.sh --dev=xml                # mode dev (auto-reload XML)
PGPASSWORD=rahasia ./run.sh       # override password Postgres
```

Prasyarat pada server:
- Interpreter Python yang bisa meng-import Odoo (dev box: `/home/masbintang/venv/bin/python`,
  diatur lewat `ODOO_PYTHON`).
- `odoo-bin` ada di base path (dev box: `/home/masbintang/linkederp/base/odoo/odoo-bin`).
- Postgres berjalan dengan role `odoo` (password default `odoo` pada dev box).

Bila base path tidak memuat `odoo-bin`, Cartenz melewati pembuatan
`odoo.conf`/`run.sh` (project tetap dibuat) dan mencatat peringatan di log.

---

## 5. Siapa Menjalankan Apa

Penting untuk membedakan dua hal:

1. **Menjalankan project sebagai dev server** — dilakukan **oleh Anda** lewat
   `./run.sh`. Agent AI tidak menyalakan server.
2. **Agent AI di dalam sebuah task** — tidak punya shell (sesuai desain sandbox
   ADR-013/022). Ia menulis dan meninjau kode, bukan menjalankan server. Bila
   diminta "jalankan project", jawabannya "tidak punya shell" adalah benar.
3. **Validasi otomatis** (opsional, task `change`) — Cartenz menjalankan
   `odoo-bin --stop-after-init --test-enable` di database scratch untuk
   meng-install dan menguji modul. Ini satu-satunya jalur di mana platform
   menjalankan Odoo, dan itu pun bukan server hidup. Dikendalikan oleh
   `VALIDATION_ENABLED` dan memerlukan role validasi (`VALIDATION_DB_*`).

---

## 6. Memberi Tugas ke Agent

Dua jenis task (ADR-029):

- **`change`** — alur pengembangan: rencana → persetujuan → implementasi →
  validasi → commit/push. Menulis modul nyata ke `addons/`.
- **`chat`** — percakapan: jawaban natural-language, tanpa perubahan kode;
  penulisan file butuh persetujuan inline; tidak pernah commit/push.

Tugas dijalankan pada **branch environment** yang dituju. Bila tidak menyebut
environment, target default adalah **Development** (branch `development`).
Production tidak bisa menjadi target.

Untuk project Community, agent hanya membaca source base Odoo (tidak enterprise),
sesuai edition (ADR-037).

---

## 7. Verifikasi Cepat

Cek bahwa project terbentuk benar:

```bash
DIR=<projects_root>/<nama_teknis>

# Branch: harus ada main, staging, development
git -C "$DIR" branch --format='%(refname:short)'

# addons_path sesuai edition
grep addons_path "$DIR/odoo.conf"

# run.sh executable
ls -l "$DIR/run.sh"
```

Cek environment lewat API:

```bash
curl -s http://127.0.0.1:4000/api/v1/projects/<PROJECT_ID> \
  -H "Authorization: Bearer <TOKEN>" | python3 -m json.tool
```

Field yang relevan: `odooEdition`, `environmentConfig.onPremisePath`, dan daftar
`environments` (Development + Staging).

---

## 8. Masalah Umum

| Gejala | Penyebab | Solusi |
|---|---|---|
| Folder project kosong / tidak ada | Project dibuat via Create with AI sebelum ADR-036, atau tipe repository-backed | Buat ulang dengan build terbaru; tipe repository memang tidak di-scaffold |
| `odoo.conf`/`run.sh` tidak ada | Base path tidak memuat `odoo-bin` | Set base path yang benar di Settings organisasi (harus root repo Odoo, bukan `odoo/addons`) |
| Community malah memuat enterprise | Path diatur lewat `ODOO_SOURCE_PATHS` (env), bukan portal | Set base + enterprise di portal agar edition bisa memilah |
| `./run.sh` gagal konek DB | Password Postgres berbeda | `PGPASSWORD=<pw> ./run.sh` |
| Agent bilang "no shell, cannot run" | Perilaku benar — agent tidak menjalankan server | Jalankan sendiri via `./run.sh` |
| Validasi tidak berjalan | `VALIDATION_ENABLED=false` atau role validasi belum ada | Aktifkan dan buat `VALIDATION_DB_*` |

---

## 9. Referensi ADR

| ADR | Isi |
|---|---|
| ADR-032 | Scaffold direktori addons project |
| ADR-033 | Odoo paths di portal, layout addons |
| ADR-034 | Project baru langsung bisa divalidasi/dijalankan |
| ADR-035 | `odoo.conf` + `run.sh` (dev server tanpa Docker) |
| ADR-036 | Create with AI di-scaffold lokal dan berjalan on-premise |
| ADR-037 | Pilihan edition Community/Enterprise per project |
| ADR-038 | Branch staging + development saat scaffold |

Detail keputusan teknis ada di `docs/adr/`.
