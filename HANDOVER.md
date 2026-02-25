# Milli-Mala: Tæknilegt yfirlit fyrir DevOps

## Hvað er þetta

Multi-tenant brú milli Zendesk og skjalakerfa (OneSystems, GoPro). Tekur á móti webhook frá Zendesk eða API kalli frá Málaskrá, sækir miða og viðhengi úr Zendesk, býr til PDF, og sendir í skjalakerfi stofnunar.

Stateless — geymir engin gögn nema valkvæðan audit log (metadata, engin persónugreinanleg gögn).

## Arkitektúr

```
Zendesk webhook ──→  milli-mala  ──→ skjalakerfi stofnunar
Málaskrá app    ──→  (container)  ──→ (OneSystems / GoPro)
```

- Einn Docker container
- Enginn gagnagrunnur, ekkert cache, engin persistent storage
- Eitt production dependency (jsPDF)
- TypeScript strict, Node.js 20, Alpine Linux
- Non-root user (UID 1001)
- Health check: `GET /v1/health`
- Port: 8080

## Endapunktar

| Method | Path | Auth | Lýsing |
|--------|------|------|--------|
| `POST` | `/v1/webhook` | Zendesk HMAC-SHA256 | Sækir miða, býr til PDF, sendir í skjalakerfi |
| `POST` | `/v1/attachments` | `X-Api-Key` header | Sendir viðhengi í skjalakerfi (kallað frá Málaskrá) |
| `GET` | `/v1/health` | Ekkert | Health check |
| `GET` | `/v1/audit` | Bearer token | Audit log fyrirspurnir (valkvæmt) |

## Tenant config

Hver stofnun er skilgreind í `tenants.json` með:
- Zendesk tengingu (subdomain, API token, webhook secret)
- Eitt eða fleiri skjalakerfi með credentials og URL
- API lykil fyrir Málaskrá
- PDF stillingar (nafn stofnunar, tungumál)

Ný stofnun bætist við með nýrri færslu í `tenants.json`. Hvernig gögn eru send í skjalakerfi er skilgreint í módúlum per kerfi (`onesystems.ts`, `gopro.ts`) — allar stofnanir á sama skjalakerfi fá sama format.

## Logging

Allt fer í stdout sem structured JSON. Persistent audit log er valkvætt — ef ekkert volume/KV er stillt er það bara stdout.

## Netumferð

**Inn:**
- HTTPS frá Zendesk (webhook)
- HTTPS frá Málaskrár appinu (API kall)

**Út:**
- `*.zendesk.com` (HTTPS) — Zendesk API
- `*.zdassets.com` (HTTPS) — Zendesk viðhengi
- Skjalakerfi URLs per stofnun (OneSystems / GoPro)

Engin önnur netumferð. Engin inbound tenging við innri net.

## Öryggi

| Eiginleiki | Útfærsla |
|------------|----------|
| Tenant einangrun | Hver stofnun hefur sinn aðgang og sitt skjalakerfi |
| Brand cross-check | Sannreynir að miði tilheyri stofnuninni, neitar ef ekki (fail-closed) |
| Webhook undirskrift | HMAC-SHA256 með `timingSafeEqual` |
| Replay vörn | Webhook timestamp innan 5 mínútna |
| SSRF vörn | Aðeins `*.zendesk.com` og `*.zdassets.com` leyfð, private IP svið lokuð |
| Injection vörn | XML escaping, CRLF sanitization, input validation |
| Engin PII í logum | Audit log geymir aðeins miðanúmer, brand_id, tímastimpil, stöðu |
| Engin leyndarmál í kóða | Allt kemur úr tenant config |
| Almenn villuboð | Engir stacktrace eða leyndarmál í svörum |

154 unit tests, `npm audit` sýnir engin þekkt veikleiki. SBOM (CycloneDX) fylgir í repo.

## X-Road

Ef X-Road er notað er það aðeins á útsendingarhliðinni. Milli-mala sendir gegnum X-Road öryggisþjón í stað beint á skjalakerfi. Krefst engra kóðabreytinga — bara breytt `baseUrl` í tenant config.

## Yfirlit

```
Tungumál:         TypeScript (strict)
Runtime:          Node.js 20 (Alpine Docker)
Port:             8080
Health check:     GET /v1/health
Dependencies:     1 (jsPDF, MIT leyfi)
Gagnagrunnur:     Enginn
Geymsla:          Engin (valkvæður audit log)
Tenant config:    tenants.json / Kubernetes Secret
Tests:            154
Leyfi:            Apache 2.0
```
