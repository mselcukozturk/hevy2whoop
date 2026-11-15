# hevy2whoop — çalışma kuralları

## Kapsam

Hevy'deki kuvvet antrenmanlarını WHOOP Strength Trainer'a kopyalayan Node.js komut satırı aracı ve MCP sunucusu. Npm paketi ve MCP Registry kaydı olarak yayımlanır. WHOOP'a yazma işini `totem` yapar; bu depo yalnız Hevy okuma, egzersiz eşleme ve yinelenme kontrolünü yapar.

- Yapılabilir: `hevy2whoop.mjs`, `mapping.json`, test ve belge düzenlemesi.
- WHOOP'a yazma (`sync --write`, `hevy2whoop_sync` aracında `write: true`) dış etkili işlemdir. Önce önizleme göster, kullanıcı onayı olmadan yazma.
- npm yayını ve MCP Registry güncellemesi kullanıcı onayı olmadan yapılmaz.

## Komutlar

Node.js 24 veya üstü gerekir. Önizleme varsayılandır; `--write` verilmedikçe WHOOP'a yazılmaz.

- `npm test` — `node test/e2e.mjs`; uçtan uca testi çalıştırır.
- `node hevy2whoop.mjs sync` — son antrenmanı önizler.
- `node hevy2whoop.mjs sync --from YYYY-MM-DD --to YYYY-MM-DD` — tarih aralığını önizler.
- `node hevy2whoop.mjs sync --write` — WHOOP'a yazar (onay gerekir).
- `node hevy2whoop.mjs catalog "<arama>"` — WHOOP egzersiz kimliklerini arar.
- `node hevy2whoop.mjs mcp` — MCP sunucusunu stdio üzerinden başlatır.

## Dosya haritası

- `hevy2whoop.mjs` — tek dosyalık uygulama (CLI ve MCP).
- `mapping.json` — Hevy egzersizinden WHOOP egzersiz kimliğine eşleme.
- `test/e2e.mjs`, `test/fake-totem.mjs` — uçtan uca test ve sahte totem.
- `docs/` — `failure-scenarios.md`, `yayin-basvurulari.md`.
- `artifacts/e2e-result.json` — test çıktısı.
- `server.json`, `glama.json`, `.well-known/`, `llms-install.md`, `AGENT_INSTALLATION.md` — yayın ve kurulum üst verisi.

## Sırlar ve yasaklar

- `HEVY_API_KEY` ortam değişkenidir; değeri sohbete, günlüğe veya commit'e yazma.
- `.env` dosyaları (`.gitignore` içinde) ve WHOOP/totem oturum belirteçleri okunmaz, yazılmaz.
- WHOOP oturumu (`totem auth`) kullanıcı tarafından açılır; ajan açmaz.
- Eşlenmemiş egzersiz için kimlik uydurma; `catalog` çıktısından seç.

## Bağlı sistemler

- Hermes işi: `/home/selcuk/.hermes/cron/jobs.json` içinde "Idman senkron bildirimi" (id `884672cd66b7`, `5 12,20 * * *`); `sync --write` çalıştırır ve anahtarı `~/.config/asistan/hevy.env` dosyasından yükler.
- Skill: `/home/selcuk/.hermes/skills/asistan/saglik-takip/SKILL.md`.
- systemd birimi (`/home/selcuk/asistan-runtime/units/*.service`): yok.
- `/home/selcuk/asistan-runtime/config/projects.json`: yok.
