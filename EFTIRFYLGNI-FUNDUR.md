# Eftirfylgni: Fundur um milli-mala hýsingu

**Dagsetning fundar:** 26. febrúar 2026
**Viðmælendur:** Ragnhildur Helga, Brynjar (Apró), Brynjólfur

---

## Svar við spurningum úr fundi

### 1. Arkitektúr — hvað er þetta nákvæmlega?

Þetta er eitt Docker container. Ekkert annað.

- Engin gagnagrunnur
- Engin Redis eða cache
- Engin persistent storage
- Eitt npm dependency (jsPDF fyrir PDF-gerð)
- Node.js 20 á Alpine Linux
- Keyrir sem non-root user (UID 1001)
- Health check á `/v1/health`

Kerfið er algjörlega stateless — það sækir gögn úr Zendesk, býr til PDF, sendir í skjalakerfi, og gleymir öllu. Ekkert er geymt í minni eftir að beiðni er afgreidd.

---

### 2. Logging — stdout eða persistent storage?

Ég skildi vel athugasemd Brynjars um að stdout sé best og persistent storage sé dýrt og flókið.

**Svona er þetta í dag:**
- Öll application logs fara í stdout sem structured JSON — tilbúið fyrir ykkur log aggregation
- Auk þess er lítill audit log sem geymir metadata (miðanúmer, tímastimpil, hvort tókst) í 90 daga

**Tillaga mín:**
Við getum alveg sleppt persistent audit log og látið allt fara í stdout. Þá sjá ykkur kerfi um geymslu og retention. Audit metadata kemur bara sem structured JSON log línur sem ykkur log aggregation grípur.

Þetta þýðir: ekkert persistent storage, ekkert volume mount fyrir logs — bara eitt stateless container sem loggar í stdout. Einfaldara fyrir ykkur að reka.

Ef þið viljið hins vegar lengri geymslu á audit upplýsingum (t.d. 90 daga eða lengur) sem krafist er vegna opinberra gagna, þá þarf annaðhvort:
- Ykkur log retention policy að ná yfir það (15 dagar er kannski of stutt fyrir eftirlit)
- Eða við höldum persistent audit log en geymum hann í volume

Þið ákveðið hvort 15 daga retention dugar eða ekki — þetta snýst um ykkur regluverk.

---

### 3. X-Road / Straumurinn

Zendesk er SaaS kerfi og kemur aldrei á X-Road. Þannig að X-Road tengist aðeins **útsendingarhlið** milli-mala — þ.e. þegar milli-mala sendir gögn í skjalakerfin.

Flæðið yrði:

```
Zendesk → milli-mala → X-Road öryggisþjónn → skjalakerfi stofnunar
```

**Góðu fréttirnar:** Þetta krefst líklega engra kóðabreytinga. X-Road virkar sem transparent proxy á HTTP laginu. Við myndum bara breyta `baseUrl` í tenant config þannig að hún bendi á X-Road öryggisþjóninn í stað beint á API stofnunar.

**Spurning til ykkar:** Er hægt að nota X-Road öryggisþjón sem þegar er til hjá Stafrænu Íslandi, eða þarf að setja upp nýjan? Þetta myndi leysa vandamál eins og hjá Fjármálaráðuneytinu sem gat ekki tengt GoPro vegna þess að þau vantaði DMZ/hlutlaust svæði.

---

### 4. Repo og CI/CD

Ég opna repo hjá Stafrænu Íslandi eins og rætt var. Tillaga:

1. Ég fork-a eða flutti repo-ið undir GitHub org Stafræns Íslands
2. Þið setjið upp CI/CD pipeline sem byggir Docker image og deployar sjálfkrafa
3. Ég get haldið áfram að leggja til breytingar gegnum pull requests
4. Þannig er þetta ekki háð mér sem einstakling

Þetta er Apache 2.0 leyfi þannig að Stafrænt Ísland á þetta alveg frjálslega.

---

### 5. Öryggisúttekt (Óli)

Ég sendi Óla aðgang að repo-inu þegar það er opnað. Til að auðvelda úttektina:

- **README.md** hefur ítarlega öryggistöflu (HMAC-SHA256, replay protection, SSRF vörn, timing-safe comparisons, tenant isolation, o.fl.)
- **119 unit tests** þar af mörg sem prófa öryggisleiðir sérstaklega (rangar undirskriftir, útrunnir tímastimplar, cross-tenant aðgangur, SSRF tilraunir)
- **SBOM** (CycloneDX) er tilbúinn í repo — sýnir öll dependency og leyfi
- **Eitt production dependency** (jsPDF) — öll önnur virkni notar innbyggð Node.js modules
- `npm audit` sýnir engin þekkt öryggisveikleika

Ef Óli vill fá kynningu eða walkthrough á kóðanum er ég til í það.

---

### 6. Tenant onboarding — hvernig bætast stofnanir við?

Í dag er þetta JSON skrá (`tenants.json`) sem inniheldur config fyrir hverja stofnun:
- Zendesk credentials (subdomain, API token, webhook secret)
- Skjalakerfi credentials (OneSystems eða GoPro)
- PDF stillingar (nafn stofnunar, tungumál, o.fl.)

Þegar ný stofnun bætist við er bara bætt nýjum færslu í JSON skrána og kerfið tekur hana upp.

Hjá ykkur myndi þetta líklega vera ConfigMap eða Secret í Kubernetes — þið ákveðið hvernig tenant config er geymdur.

---

### 7. Fjármálaráðuneytið og DMZ

Eins og ég nefndi á fundinum — Fjármálaráðuneytið var í vandræðum með að tengja GoPro vegna þess að þau vantaði hlutlaust svæði (DMZ). Milli-mala leysir þetta nákvæmlega:

- Milli-mala situr á milli og hvorugt kerfið sér credentials hins
- Stofnunin þarf ekki að opna sitt kerfi beint á netið
- Ef X-Road er notað er enn öruggara — allt fer gegnum dulkóðaðan X-Road rás

Þetta gæti sparað verkefnið sem var áætlað að kosta tugi milljóna. Vert að ræða við Línu og Óla.

---

## Næstu skref (eins og ég skil þau)

| # | Verkefni | Ábyrgð | Staða |
|---|----------|--------|-------|
| 1 | Opna repo hjá Stafrænu Íslandi | Brynjólfur + Ragnhildur | Bíður |
| 2 | Skoða hvernig þetta fellur að stöðlum | Brynjar / DevOps | Bíður repo |
| 3 | Öryggisúttekt | Óli (Ragnhildur pingar) | Bíður |
| 4 | Ákveða logging stefnu (stdout only vs persistent audit) | DevOps teymi | Bíður |
| 5 | Ákveða X-Road eða beintengingu við stofnanir | Ragnhildur + Lína + Óli | Bíður |
| 6 | Cluster / namespace ákvarðanir | Brynjar / DevOps | Bíður |
| 7 | Setja upp CI/CD pipeline | DevOps teymi | Bíður repo |
| 8 | Tenant config í KeyStore/Secret | DevOps teymi | Bíður |
