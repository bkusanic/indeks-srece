# Indeks sreće — mobilna aplikacija (Expo / React Native)

Aplikacija s dva sloja: **sreća** (World Happiness Report, 2011.–2025.) i **natalitet**
(UN World Population Prospects 2024). Četiri kartice: Faktori, Ljestvica, Profil zemlje, Natalitet.

Ovaj folder NIJE cijeli projekt — sadrži samo datoteke koje pišem ja (`App.js`, `data/`,
`eas.json`, `app.json`). Ostatak (node_modules, package.json s točnim verzijama) generira
Expo na tvom računalu u koraku 1. Tako izbjegavamo probleme s nepoklapanjem verzija.

---

## Što ti treba unaprijed (jednom)

- **Node.js** (LTS verzija) — https://nodejs.org
- Telefon s **Android**-om i instaliranom aplikacijom **Expo Go** (Play Store) — za brzo testiranje
- (za APK) besplatan **Expo račun** — https://expo.dev/signup

Ne treba: Android Studio, Apple račun, ni Play Store račun.

---

## Korak 1 — Napravi prazan Expo projekt

```bash
npx create-expo-app@latest indeks-srece --template blank
cd indeks-srece
npx expo install react-native-svg
npx expo install @react-native-async-storage/async-storage
```

(`async-storage` treba za novu karticu **Podaci** — trajno spremanje godina koje sam uneseš.
U Expo Snacku ga dodaš kroz *Dependencies*.)

## Korak 2 — Ubaci moje datoteke

Iz ovog foldera prekopiraj u novonastali `indeks-srece/`:

```
App.js            ->  zamijeni postojeći App.js
app.json          ->  zamijeni postojeći app.json
eas.json          ->  novi file (u korijen projekta)
data/whr.json     ->  napravi folder data/ i stavi unutra
data/tfr.json     ->  isto u data/
data/analysis.json -> isto u data/ (klasteri zemalja)
```

Struktura nakon toga:

```
indeks-srece/
├─ App.js
├─ app.json
├─ eas.json
├─ data/
│  ├─ whr.json
│  └─ tfr.json
├─ package.json        (generiran u koraku 1)
└─ ...
```

## Korak 3 — Pokreni na telefonu (Expo Go, bez buildanja)

```bash
npx expo start
```

Skeniraj QR kod aplikacijom Expo Go (telefon i računalo na istom WiFi-ju). Aplikacija se
učita za par sekundi. Mijenjaš `App.js` → promjena se odmah vidi na telefonu.

> Ovo je 90% razvoja. Za samu izradu i isprobavanje ti dalje ništa ne treba.

---

## Korak 4 — Napravi APK koji sam instaliraš (samostalna aplikacija)

Kad želiš pravu ikonu na ekranu koja radi bez Expo Go:

```bash
npm install -g eas-cli       # jednom
eas login                    # prijavi se svojim Expo računom
eas build -p android --profile preview
```

EAS odradi build u cloudu (~10–15 min) i vrati **link na `.apk`**. Otvori link na telefonu
(ili prebaci APK preko USB-a / Google Drivea), pokreni ga, Android pita za dopuštenje
instalacije iz nepoznatog izvora → potvrdiš → instalirano. Radi offline, neograničeno.

Profil `preview` u `eas.json` već je namješten da gradi APK (a ne AAB), baš zato da ga možeš
sam instalirati.

### (alternativa) build bez clouda, lokalno

Ako imaš instaliran Android SDK:

```bash
eas build -p android --profile preview --local
```

---

## Ažuriranje aplikacije

- Sitne promjene koda → samo napraviš novi build i reinstaliraš APK.
- Godišnje osvježavanje podataka → zamijeniš `data/whr.json` i `data/tfr.json` novim
  vrijednostima i ponovno buildaš. (Kasnije možemo dodati automatsko povlačenje s interneta.)

---

## Nove funkcije (v2)

- **Faktori**: preklopnik "Čisti utjecaj" (višestruka regresija — neovisni doprinos svakog
  faktora uz kontrolu ostalih) / "Udio varijance" (stara metoda). Regresija se računa u samoj
  aplikaciji pa radi i za godine koje sam dodaš.
- **Profili sreće**: zemlje grupirane po strukturi sreće (k-means klasteri), s opisima.
- **Profil zemlje**: oznaka nadmašuje li zemlja očekivanje modela (rezidual regresije)
  i kojem klasteru pripada.
- **Podaci**: unos novih godina kad izađe novo WHR izvješće — zalijepiš retke
  `Zemlja;ocjena;BDP;podrška;zdravlje;sloboda;velikodušnost;korupcija`, rang se računa sam,
  sprema se trajno na uređaj (AsyncStorage) i odmah radi u svim karticama.

## Sljedeći slojevi (kad budeš spreman)

Svaki novi sloj (religioznost, izbori…) ide istim obrascem: dodaš `data/<sloj>.json`,
novu karticu u `App.js` i graf. Logika korelacije je već u `App.js` (funkcija `pearson`).

## Napomene

- Fontovi su sistemski (bez vanjskih ovisnosti). Ako poželiš onaj karakterniji izgled s
  weba, dodajemo `expo-font` + Google font kasnije.
- Grafovi su nacrtani ručno preko `react-native-svg` da projekt ostane lagan i stabilan.


---

## Deploy

### Web aplikacija na GitHub Pages (bez instalacija — build radi GitHub)

1. Na github.com napravi **novi javni repozitorij** imenom `indeks-srece`.
2. Prenesi SVE datoteke projekta (uključujući folder `.github`) — može i povlačenjem
   u preglednik ("uploading an existing file"). Commit na granu `main`.
3. U repozitoriju: **Settings → Pages → Source: GitHub Actions**.
4. Svaki push na `main` pokreće workflow `deploy-web.yml` koji builda i objavi app na:
   `https://TVOJE-KORISNICKO-IME.github.io/indeks-srece/`
5. Ako repozitorij nazoveš drugačije, promijeni `experiments.baseUrl` u `app.json`
   da odgovara imenu (npr. `/moj-repo`).

Napomena: kartica Podaci na webu sprema u localStorage preglednika (po uređaju/pregledniku).

### Android APK

**S računala (Node.js):**
```bash
npm install -g eas-cli
eas login
eas build -p android --profile preview
```
Dobiješ link na .apk → otvoriš na telefonu → instaliraš.

**Bez instalacija (preko weba):** na expo.dev poveži GitHub repozitorij
(Projects → Create project → povezivanje s GitHubom) i pokreni build `preview` profila
iz Expo nadzorne ploče — build se vrti u oblaku, APK link stigne u preglednik.
