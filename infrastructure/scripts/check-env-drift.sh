#!/usr/bin/env bash
# Bandingkan /opt/cartenz/.env dengan nilai yang BENAR-BENAR dipegang proses.
#
# Kenapa perlu: systemd membaca EnvironmentFile sekali saja saat unit di-start, jadi
# mengedit .env tidak mengubah apa pun sampai unit di-restart. Skrip ini menunjukkan
# kunci mana yang tertinggal (nilainya tidak dicetak, hanya nama kuncinya).
#
#   bash infrastructure/scripts/check-env-drift.sh
#
# Keluar dengan status 1 kalau ada selisih, supaya bisa dipakai di pipeline.

set -uo pipefail
cd /opt/cartenz || exit 2

units=(cartenz-api cartenz-worker cartenz-portal)
drift_total=0

# systemd membuang tanda kutip di sekeliling nilai (GIT_AUTHOR_NAME="LinkedERP AI Agent"
# sampai ke proses sebagai LinkedERP AI Agent), jadi perbandingan dilakukan setelah
# kutip dibuang — kalau tidak, kunci seperti itu selalu tampak "berbeda".
strip_quotes() { printf '%s' "$1" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"; }

for u in "${units[@]}"; do
  pid=$(systemctl show "$u" -p MainPID --value 2>/dev/null)
  if [ -z "$pid" ] || [ ! -r "/proc/$pid/environ" ]; then
    echo "$u: proses tidak terbaca (unit mati atau environ tidak bisa diakses)"
    continue
  fi

  proc=$(tr '\0' '\n' < "/proc/$pid/environ")
  drift=""
  checked=0
  while IFS= read -r line; do
    key=${line%%=*}
    file_value=$(strip_quotes "${line#*=}")
    proc_value=$(strip_quotes "$(printf '%s\n' "$proc" | grep -m1 "^$key=" | cut -d= -f2-)")
    checked=$((checked + 1))
    [ "$file_value" != "$proc_value" ] && drift="$drift $key"
  done < <(grep -E '^[A-Z0-9_]+=' .env)

  if [ -n "$drift" ]; then
    echo "$u: SELISIH ->$drift   (file vs proses; restart unit ini)"
    drift_total=$((drift_total + 1))
  else
    echo "$u: sinkron ($checked kunci diperiksa)"
  fi
done

if [ "$drift_total" -gt 0 ]; then
  echo
  echo "Catatan: restart tidak ada di allow-list sudoers, jadi jalankan sebagai root:"
  echo "  sudo systemctl restart cartenz-api cartenz-worker"
  echo "Khusus NEXT_PUBLIC_* untuk portal, restart tidak cukup — nilai itu ditanam saat"
  echo "'next build', jadi perlu build ulang dengan variabelnya di-export dulu."
  exit 1
fi
exit 0
