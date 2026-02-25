# Eftirfylgni: Fundur um milli-mala hýsingu

**Dagsetning fundar:** 26. febrúar 2026
**Viðmælendur:** Ragnhildur Helga, Brynjar (Apró), Brynjólfur

---

## Svar við spurningum úr fundi

### 1. Arkitektúr

Eitt Docker container. Engin gagnagrunnur, engin cache, engin persistent storage. Eitt npm dependency (jsPDF). Node.js 20 á Alpine Linux, non-root user, health check á `/v1/health`. Stateless — gleymir öllu eftir hverja beiðni.

### 2. Logging

Allt fer í stdout sem structured JSON. Persistent audit log er valkvætt — ef ekkert KV namespace eða volume er stillt þá er það bara stdout og ekkert annað. Ekkert þarf að breyta í kóðanum.

### 3. X-Road

Zendesk kemur aldrei á X-Road. Ef X-Road er notað er það aðeins á útsendingarhlið — milli-mala sendir gegnum X-Road öryggisþjón í stað beint á skjalakerfi stofnunar. Krefst engra kóðabreytinga, bara breytt `baseUrl` í tenant config.

### 4. Repo og CI/CD

Ég opna repo undir GitHub org Stafræns Íslands. Apache 2.0 leyfi.

### 5. Öryggisúttekt (Óli)

Í repo-inu er:
- Öryggistafla í README
- 154 unit tests (þar af mörg sem prófa öryggisleiðir)
- SBOM (CycloneDX)
- Eitt production dependency
- `npm audit`: engin þekkt öryggisveikleiki

### 6. Tenant config og skjalakerfi

Hver stofnun er skilgreind í `tenants.json` með:
- Zendesk tengingu (subdomain, API token, webhook secret)
- Eitt eða fleiri skjalakerfi (OneSystems og/eða GoPro) með credentials og URL
- API lykil fyrir Málaskrá
- PDF stillingar (nafn stofnunar, tungumál)

Stofnun getur haft marga skjalakerfis-endapunkta. Beiðnin segir hvaða endapunkt á að nota hverju sinni.

Þegar ný stofnun bætist við er bara bætt færslu í `tenants.json` með credentials og URL. Hvernig gögnin eru send (JSON, multipart, o.s.frv.) er skilgreint í módúlum per skjalakerfi (`onesystems.ts`, `gopro.ts`) — allar stofnanir sem nota sama skjalakerfi fá sama format. Ef nýtt skjalakerfi bætist við þarf að bæta við nýjum módúl.

---

## Næstu skref

| # | Verkefni | Ábyrgð | Staða |
|---|----------|--------|-------|
| 1 | Opna repo hjá Stafrænu Íslandi | Brynjólfur + Ragnhildur | Bíður |
| 2 | Skoða hvernig þetta fellur að stöðlum | Brynjar / DevOps | Bíður repo |
| 3 | Öryggisúttekt | Óli (Ragnhildur pingar) | Bíður |
| 4 | Ákveða X-Road eða beintengingu | Ragnhildur + Lína + Óli | Bíður |
| 5 | Cluster / namespace / CI/CD | Brynjar / DevOps | Bíður repo |
