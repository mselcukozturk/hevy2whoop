# Yayın başvuruları için hazır metinler

Bu dosya `~/arastirma/mcp-dizinleri/rapor.md` sırasına göre hazırlandı. Form açıldığında alanları
buradan kopyala. Hiçbir başvuru bu dosya yazıldığında gönderilmedi.

## Ortak alanlar

- Ad: `hevy2whoop`
- Depo: `https://github.com/mselcukozturk/hevy2whoop`
- Lisans: MIT
- Dil/runtime: Node.js >= 24
- Transport: stdio
- Kurulum (npm sonrası): `npx -y hevy2whoop mcp`
- Gerekli ortam değişkeni: `HEVY_API_KEY` (Hevy Pro)
- Site: `https://github.com/mselcukozturk/hevy2whoop#readme`
- Kategori: Health & Fitness / Productivity

## Kısa açıklama (60 karakter)

Copy Hevy strength workouts into WHOOP Strength Trainer.

## Orta açıklama (140 karakter)

Reads workouts from the Hevy API and writes every exercise, set, rep and weight into WHOOP
Strength Trainer through the totem MCP server.

## Uzun açıklama

hevy2whoop copies strength workouts logged in Hevy into WHOOP Strength Trainer, preserving each
exercise, set, rep count and weight. Hevy has no WHOOP integration, so without this tool the sets
must be re-entered by hand after every session.

The tool runs locally over stdio. It reads workouts from the official Hevy API with your own API
key and writes to WHOOP through totem, an MCP server that uses WHOOP's private iOS API. Writes are
opt-in: the sync tool only writes when called with `write: true`, and it reports a preview by
default. Workouts already present in WHOOP are skipped.

Not affiliated with Hevy or WHOOP. WHOOP has no public write API; totem's approach is not
permitted by WHOOP's terms, which the README states plainly.

## Glama

- Add Server: GitHub URL + ad + açıklama.
- `glama.json` depoda hazır (maintainer: mselcukozturk).
- Değerlendirme Dockerfile isteyebilir; totem host'ta çalıştığı için container içinde çalışmaz,
  bunu not olarak yaz.

## mcpservers.org

- Form: ad, kategori, açıklama, repo, belge, e-posta.
- Ücretsiz kuyruk, inceleme hedefi 2 hafta.
- Not: remote değil, yerel stdio sunucusu.

## MCP Market

- GitHub repo formu, ücretsiz kuyruk ortalama 4-6 hafta.
- Not: yerel stdio, npm paketi.

## Resmî MCP Registry

1. `npm publish` (kullanıcı `npm login` yapmalı).
2. `server.json` depoda hazır, şeması doğrulandı.
3. `mcp-publisher init` gereksiz; mevcut `server.json` ile `mcp-publisher validate` ve
   GitHub doğrulaması sonrası `publish`.

## Kalan engeller

- npm yayını: `npm login` kullanıcıda (TickTick görevi 10 Kasım).
- Registry yayını npm paketi olmadan tamamlanmaz.
- Docker ve Claude Desktop dizini: totem host'a bağımlı, gizli API nedeniyle riskli; raporda
  sonraya bırakıldı.
