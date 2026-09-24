# 9Router · SAIRI edition (Docker + Pterodactyl)

Image Docker untuk 9Router yang siap dipakai di **Pterodactyl / Pelican** (menu bernomor,
tanpa tombol panah) dan juga bisa dipakai di Docker biasa.

9Router **di-build di GitHub Actions**, bukan di panel. Jadi server panel hanya menarik image
yang sudah jadi, tidak perlu `npm install` atau build Next.js (yang butuh RAM besar).

## Isi folder `docker/`

| File | Fungsi |
|---|---|
| `Dockerfile` | Build 9Router (multi-stage) lalu hasilnya dipasang di image runtime kecil (Node 22) |
| `entrypoint.sh` | Banner 9ROUTER + info sistem, tanya y/n, lalu menjalankan 9Router (mode Pterodactyl / CLI / headless) |
| `server-headless.sh` | Mode headless: web server langsung tanpa menu (`docker run -d`) |
| `egg-9router.json` | Egg Pterodactyl siap import |

Perubahan di kode 9Router (folder `cli/`): menu bernomor untuk console tanpa panah,
port otomatis dari `SERVER_PORT`, opsi `--password`, dan env `NINEROUTER_NO_UPDATE_CHECK=1`.

## 1. Upload ke repo baru

```bash
cd 9router-sairi-repo
git init -b main
git add .
git commit -m "9Router SAIRI edition"
git remote add origin https://github.com/USERNAME/NAMA-REPO.git
git push -u origin main
```

Setelah push, tab **Actions** otomatis menjalankan workflow `Docker` dan mem-push image ke
`ghcr.io/USERNAME/NAMA-REPO:latest` (huruf kecil semua).

Agar Pterodactyl bisa menarik image tanpa login: di GitHub buka **Packages → (image) →
Package settings → Change visibility → Public**.

## 2. Pasang di Pterodactyl

1. Buka `docker/egg-9router.json`, ganti `ghcr.io/USERNAME/REPO:latest` dengan image kamu.
2. Admin panel → **Nests** → **Import Egg** → pilih file itu.
3. Buat server dengan egg **9Router**. Isi variabel **Dashboard Password** (minimal 6 karakter).
4. Start. Setelah banner muncul, console bertanya **Jalankan 9Router sekarang? (y/n)**.
   - `y` (atau Enter, atau tidak menjawab 30 detik): 9Router jalan, menu bernomor muncul.
   - `n`: 9Router tidak dijalankan, kamu dapat shell untuk mengetik perintah (mis. `git`).
   Jawaban otomatis `y` memastikan restart otomatis panel tidak berhenti menunggu jawaban.
   Ketik angka lalu Enter di kolom command untuk memilih menu.
5. Dashboard: `http://IP-server:PORT` (port dari allocation).

Startup command egg: `9router --port {{SERVER_PORT}} --simple-menu`.
Untuk mode tanpa menu, ganti dengan `9router-server`.

Stop memakai `^C`. Data (database, settings) tersimpan di `/home/container/.9router`.

## 3. Pakai di Docker biasa

```bash
# tanpa menu, jalan di background
docker run -d --name 9router --restart always \
  -p 2002:2002 -e SERVER_PORT=2002 \
  -e INITIAL_PASSWORD="GantiPasswordMu" \
  -v 9router-data:/home/container \
  ghcr.io/USERNAME/NAMA-REPO:latest

# dengan menu interaktif (panah atas/bawah bekerja di terminal biasa)
docker run -it --rm -p 20128:20128 -v 9router-data:/home/container \
  ghcr.io/USERNAME/NAMA-REPO:latest
```

Build lokal: `docker build -f docker/Dockerfile -t 9router-sairi .` (butuh RAM sekitar 4 GB).

## Environment variable

| Variabel | Fungsi | Default |
|---|---|---|
| `SERVER_PORT` / `PORT` | Port server | `20128` |
| `INITIAL_PASSWORD` | Password dashboard. Wajib diisi agar bisa login dari luar | kosong |
| `SHOW_IP` | `true` menampilkan IP address di banner. Only restart: berlaku setelah restart | `false` |
| `START_PROMPT_TIMEOUT` | Detik menunggu jawaban y/n sebelum otomatis `y` | `30` |
| `BIND_HOST` | Interface untuk mode headless | `0.0.0.0` |
| `NINEROUTER_SIMPLE_MENU` | `1` paksa menu bernomor, `0` paksa menu panah | otomatis |

Catatan: di startup command Pterodactyl, jangan taruh password yang mengandung spasi atau
karakter shell (`$`, `;`, `&`). Pakai variabel egg `INITIAL_PASSWORD`, bukan flag `--password`.

## Update

Update = build image baru (push ke `main` atau buat tag `vX.Y.Z`), lalu **Reinstall/Restart**
server di panel agar image terbaru ditarik. Cek update bawaan 9Router dimatikan di image ini.
