# Diagnosis: "Every configured provider failed" dan "step budget of 12 was exhausted"

**Date:** 23 September 2026
**Status:** Fixed in code; awaiting service restart
**Commit:** see `git log --oneline --grep="budget"`

Dua pesan kegagalan yang dilaporkan operator pada 23 September 2026 berasal dari
dua cacat berbeda. Keduanya nyata, keduanya direproduksi dari log dan data task,
dan keduanya sudah dipatch. Sebagian laporan lain yang mirip sebenarnya adalah
satu cacat ketiga (worker yatim) yang menyamar sebagai cacat provider.

---

## 1. Pesan kegagalan menuduh kredensial yang tidak bermasalah

### Gejala

```
Every configured provider failed. Priority 1 (deepseek): openai-compatible
rejected the request. Then Hermes (local gateway): openai-compatible was
unavailable.; with-money: openai-compatible rejected the request.;
openai-compatible: openai-compatible rejected the request.; Masbin:
openai-compatible was unavailable.
```

Lima provider berbeda dilaporkan menolak request dalam satu detik. Operator
menyimpulkan "AI tidak compatible" dan khawatir kredensialnya rusak. Kedua
kesimpulan itu salah — dan pesan itu yang menyebabkannya.

### Bukti

`task_139989` gagal 11:50:09 WIB dengan pesan di atas. Log worker pada detik
yang sama:

```
11:40:02 ERROR [AiSdkModelProvider] openai-compatible/deepseek-flash failed:
         No object generated: could not parse the response.
11:40:03 WARN  [FailoverModelProvider] Priority 1 (deepseek) failed structured
         generation: openai-compatible rejected the request.. Trying the next provider.
```

Akar sebenarnya terlihat di baris sebelumnya:

```
AI SDK Warning (linkederp-self-hosted.chat / deepseek-flash): The feature
"responseFormat" is not supported. JSON response format schema is only
supported with structuredOutputs
WARN [AiSdkModelProvider] openai-compatible/deepseek-flash produced a response
that did not match the schema; retrying (attempt 2/2)
```

Ini bukan penolakan request. HTTP-nya 200. Model menjawab, jawabannya bukan
JSON yang valid untuk schema plan, SDK melempar `NoObjectGeneratedError`,
failover chain mencoba provider berikutnya, semuanya gagal dengan alasan yang
sama persis, dan `FailoverModelProvider.exhausted()` melaporkan gabungannya.

Kata "rejected" datang dari `AiSdkModelProvider.explain()`: ketika error bukan
retryable dan tidak ada HTTP status yang dikenali, cabang `default` menghasilkan
`"${id} rejected the request."` — kalimat yang secara harfiah salah untuk kasus
ini. Yang benar: model menjawab, jawabannya tidak bisa dipakai.

### Kenapa lima provider gagal bersamaan

`AI_STRUCTURED_OUTPUTS=false` (baris 90 `.env`) menaruh seluruh jalur ke mode
`json_object`. Dalam mode itu schema tidak pernah dikirim ke endpoint — hanya
dikomunikasikan lewat prompt. Semua row di `model_settings` yang
`structured_outputs` NULL ikut terbawa, termasuk `with-money` dan `Masbin` yang
round-robin ke `mimo-v2.6-flash`. Model flash ini tidak konsisten menghasilkan
objek yang cocok untuk schema plan yang besar.

Ini juga menjelaskan observasi operator: **mode chat selalu bisa, mode change
selalu gagal.** Chat memakai `generateText` (teks bebas, tidak ada schema).
Change memakai `generateObject` (schema ketat). Provider yang sama, permintaan
yang berbeda, hasil yang berbeda.

### Perbaikan

1. **Retry schema miss dibuat konfigurabel dan didorong** (`d1fb006` sebelumnya):
   `AI_STRUCTURED_MAX_ATTEMPTS` default 3 (sebelumnya hardcoded 2).
2. **Retry kini membawa umpan balik** — lihat §2 di bawah. Tiga percobaan
   identik pada temperature 0 cenderung menghasilkan jawaban rusak yang sama;
   itu sebabnya 2 attempt tetap habis. Attempt ke-2 dan seterusnya menyertakan
   teks jawaban model sebelumnya (dipotong 400 karakter) dan instruksi eksplisit:
   satu objek JSON, tanpa prosa, tanpa fence markdown.
3. **Pesan kegagalan diperbaiki** (`explain()`): `NoObjectGeneratedError` dan
   `ZodError` kini menghasilkan
   `"openai-compatible answered, but not in the JSON this platform needs for a plan"`
   alih-alih `"rejected the request"`. Seseorang yang membaca laporan kegagalan
   tidak lagi diarahkan mengejar masalah kredensial yang tidak ada.

### Yang TIDAK diubah, sengaja

- **Urutan prioritas `model_settings`.** Menaruh provider ber-`structured_outputs: true`
  di posisi 1 untuk planning akan mengubah model yang menjawab semua task —
  perubahan perilaku yang jauh lebih besar dari yang diminta, dan keputusan
  operator, bukan bug.
- **`AI_STRUCTURED_OUTPUTS`.** Menyalakannya `true` terhadap endpoint yang
  menolak `response_format: json_schema` (DeepSeek) akan gagal keras pada task
  pertama. `false` adalah konfigurasi yang benar untuk deployment ini.
- **401 pada endpoint non-gateway.** Probe eksternal yang memakai
  `AI_API_KEY` global (kunci gateway) untuk semua target termasuk
  `api.deepseek.com` adalah artefak salah key, bukan temuan. Operator telah
  mengonfirmasi kredensial bisa dipakai.

---

## 2. "No change was made to the working tree: the step budget of 12 was exhausted"

### Gejala

```
task_791505 Failed — No change was made to the working tree: the step budget of
12 was exhausted.
task_118267 Failed — No change was made to the working tree: the tool-call
budget of 30 was exhausted.
```

### Bukti — kedua task membaca, tidak pernah menulis

`task_791505` (12:10:43–12:12:08 WIB), 41 aksi tercatat:

- 24 tool call, 12 step penuh.
- `detect_odoo_version`, `list_modules`, `list_directory`, `read_file`,
  `search_code` — **semua berstatus `succeeded`**.
- Nol `edit_file` / `create_file` / `update_file`.
- Tiga penolakan (`addons`, `addons/base/models`,
  `addons/base/models/ir_cron.py`) tetap dihitung sebagai langkah.

`task_118267` (gagal 11:56:44): 30 tool call, semua `succeeded`, semuanya
baca — `list_directory`, `read_file`, `search_code`, `list_modules`. Nol tulis.
Plan task ini 13 file; task_791505 19 file.

Keduanya adalah task besar di repo yang tidak dikenal model. Model flash
menyusuri repository dulu, dan anggaran habis sebelum satu pun edit dilakukan.

### Anggaran yang terlalu ketat

`AI_MAX_STEPS=12`, `AI_MAX_TOOL_CALLS=30` (`.env` baris 190–191), Zod default
12/30 dengan batas atas 50/200. Angka 12 adalah angka bulat lama, bukan angka
yang diturunkan dari distribusi task nyata: perubahan biasa memakai 4–10 step.

### Perbaikan

1. **Anggaran dinaikkan**: default Zod `12 → 30` step dan `30 → 60` tool call;
   batas atas `50 → 200` dan `200 → 500`. `.env` dan `.env.example` diubah ke
   30/60. Keduanya dinaikkan bersama — mengetatkan satu sambil membiarkan yang
   lain hanya memindahkan pesan kegagalan, tidak menghilangkan kegagalannya.
2. **Prompt implementasi** tidak lagi menyuruh model mengulang panggilan yang
   disebut "final". Aturan "for EVERY file you must call a write tool" tetap,
   tetapi kini berpasangan dengan anggaran yang cukup untuk benar-benar
   melakukannya.
3. **Prompt sistem** kini memberi tahu model bahwa pesan penolakan yang
   mengutip path berbeda dari yang dikirim adalah bug platform — jangan
   habiskan langkah untuk itu, laporkan di ringkasan.

---

## 3. cacat ketiga: dua worker aktif bersamaan (penyebab sebagian laporan di atas)

### Temuan

PID **44235** — `node /opt/cartenz/backend/dist/worker.js`, UID 0 (root),
mulai **16 September 2026 21:14**, umur 6 hari 15 jam, berada di cgroup
`user.slice/user-1000.slice/session-741.scope` (SSH session, bukan systemd
unit). Menulis ke `/opt/cartenz/.runtime/worker.log`.

PID **2755364** — `node dist/worker.js`, UID 997 (cartenz), mulai
**23 September 11:55:41**, di cgroup `system.slice/cartenz-worker.service`,
menulis ke `/var/log/cartenz/worker.log`.

Keduanya menjalankan `dist/worker.js` yang sama dan keduanya terhubung ke
BullMQ queue `bull:YWdlbnQtdGFza3M=` (agent-tasks). Redis
`client list` menunjukkan dua koneksi `name=bull:YWdlbnQtdGFza3M=` — satu
`idle=3`, satu `idle=1575`.

### Dampak

Job `execute-task` / `resume-task` yang sama bisa dikonsumsi oleh worker mana
pun. Worker yatim (44235) menjalankan kode lama — ia tidak punya
`AI_STRUCTURED_MAX_ATTEMPTS`, dan tidak yakin punya patch ADR-060. Sebagian
task yang laporannya aneh (planning gagal di provider yang di unit systemd
tampak sehat; transisi `pushing → waiting_approval` ilegal muncul di log lama)
berasal dari worker yang salah.

Log yang dibaca operator bisa berada di file mana pun tergantung worker mana
yang mengambil job — itu sebabnya temuan tidak pernah konsisten antar inspeksi.

### Perbaikan

PID 44235 dimulai dari session SSH root (`session-741.scope`, cgroup
user.slice), bukan dari unit systemd, sehingga `systemctl restart
cartenz-worker` tidak menyentuhnya. `kill` dari sesi ini tidak punya
izin (UID 997 vs UID 0).

Ini **tidak bisa diselesaikan dari sesi ini**. Perintah root:

```bash
kill 44235 && sleep 2 && pgrep -af 'dist/worker.js'
```

Harus tersisa tepat satu baris: `PID 2755364 /usr/bin/node dist/worker.js`.
Bila muncul lagi dengan UID 0, itu berarti ada yang menjalankan worker
manually dari shell — hentikan kebiasaan itu; worker dijalankan systemd saja.

---

## 4. cacat keempat: path read-only root ter-strip jadi string kosong

### Bukti

`task_791505`, aksi sequence 26:

```
input:  {"path": "addons"}
output: {"error": "Refused the path \"\": it is empty"}
```

Model mengirim `"addons"`, platform melaporkan menolak `""`. Pesan itu tidak
pernah cocok dengan input, dan model menghabiskan langkah untuk itu.

### Akar

`resolveReadPath()` mencocokkan path terhadap read-only roots
(`ODOO_SOURCE_PATHS=/opt/odoo/odoo-server,/opt/odoo/enterprise` → prefix
`odoo-server`, `enterprise`). Ketika `readOnlyRootFor()` cocok pada
**prefix itu sendiri** tanpa segmen sisanya, `requested.slice(prefix.length)`
menghasilkan string kosong, dan `assertPlausibleRelativePath("")` melempar
`"it is empty"`.

Reproduksi lokal pada `dist/` yang sudah dibangun (prefix `odoo`) mengonfirmasi
bahwa `resolveExistingPath(root, ".")` sendiri sehat — jadi ini murnu kasus
prefix tanpa segmen, bukan kasus `.`.

### Perbaikan

`resolveReadPath()`: bila `relative === ''`, kembalikan
`resolveExistingPath(match.path, '.')` — root itu sendiri adalah direktori yang
bisa di-list. Test baru: *"resolves the read-only root itself, not an empty path"*.

---

## Verifikasi

| Gate | Hasil |
|---|---|
| `npx tsc -p tsconfig.json --noEmit` | 17 error, semuanya pre-existing di `git-credentials.spec.ts` |
| `npx jest --silent` | **77 suites / 914 tests PASS** (baseline lama 77/913) |
| `rm -rf dist && npx tsc -p tsconfig.build.json --noCheck` | `BUILD_EXIT=0` |
| Marker di `dist/` | `resolveExistingPath(match.path, '.')`=1, `structuredMaxAttempts`=1, `max(200)`=1 |

## Yang masih menunggu restart

Service menjalankan kode lama sampai:

```bash
sudo systemctl restart cartenz-api cartenz-worker
```

(`cartenz-portal` tidak perlu — tidak ada perubahan frontend.)

Setelah restart, **bunuh juga worker yatim PID 44235** (§3) — restart unit
tidak menyentuhnya.

Belum diverifikasi end-to-end karena keduanya butuh restart:

- Task change benar-benar menulis file dan menembus anggaran 30 step.
- Failover tak lagi melaporkan "rejected the request" untuk miss schema.
- Reattach workspace + verifikasi commit task di produksi (ADR-060).

## Konfigurasi terkait (`.env`)

| Variabel | Nilai | Catatan |
|---|---|---|
| `AI_STRUCTURED_OUTPUTS` | `false` | Benar untuk DeepSeek; jangan diubah ke `true` |
| `AI_STRUCTURED_MAX_ATTEMPTS` | `3` | BARU; sebelumnya hardcoded 2 |
| `AI_MAX_STEPS` | `30` | Dinaikkan dari 12 |
| `AI_MAX_TOOL_CALLS` | `60` | Dinaikkan dari 30 |
| `GIT_AUTO_PUSH_ON_TASK` | `true` | ADR-060 |
