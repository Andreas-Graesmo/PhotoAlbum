# Fotoalbum

Et passordbeskyttet fotoalbum. Selve nettsiden ligger på **GitHub Pages**, mens bildene og passordsjekken ligger hos **Cloudflare** (R2-lagring + en Worker).

```
site/      Nettsiden (GitHub Pages)
  index.html   Albumet for besøkende: meny, høydepunkter, lysbildefremvisning
  admin.html   Admin: lag album, last opp mappe, velg høydepunkter, rekkefølge
  config.js    Navn på siden og adressen til API-et
worker/    API-et (Cloudflare Worker) som sjekker passord og serverer bildene
```

## Slik fungerer beskyttelsen

- Besøkende skriver inn **ett felles passord**. Admin-siden krever et **eget admin-passord**.
- Bildene ligger i en privat R2-bøtte. De kan bare hentes via signerte lenker som Workeren lager etter innlogging, og lenkene utløper etter 1–2 uker.
- Selve HTML/JS-koden på GitHub Pages er offentlig, men den inneholder ingen bilder eller passord.
- Bildene krympes i nettleseren før opplasting (maks 2560 px, ca. 0,5–1 MB), så 10 GB gratis lagring rommer rundt 10 000+ bilder.

## Oppsett (én gang)

### 1. Cloudflare

1. Lag en gratis konto på <https://dash.cloudflare.com>.
2. Gå til **R2 Object Storage** og aktiver R2 (krever betalingskort, men 10 GB er gratis).
3. I en terminal:

```bash
cd worker
npm install
npx wrangler login
npx wrangler r2 bucket create photo-album
npx wrangler secret put VIEWER_PASSWORD
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put TOKEN_SECRET
```

For `TOKEN_SECRET` bruker du en lang tilfeldig streng (f.eks. 40 tilfeldige tegn). Bytter du den, blir alle logget ut.

4. Åpne `worker/wrangler.toml` og bytt `BRUKERNAVN` i `ALLOWED_ORIGINS` med GitHub-brukernavnet ditt.
5. Publiser API-et:

```bash
npx wrangler deploy
```

Kommandoen skriver ut en adresse som `https://photo-album-api.<konto>.workers.dev`.

### 2. GitHub Pages

1. Lim inn Worker-adressen i `site/config.js` (`apiUrl`).
2. Lag et repo på GitHub og push koden til `main`.
3. Gå til **Settings → Pages** og velg **Source: GitHub Actions**.
4. Siden publiseres automatisk til `https://<brukernavn>.github.io/<repo>/` ved hver push.

## Bruk

1. Gå til `…/admin.html` og logg inn med admin-passordet.
2. Lag et album (f.eks. «Sommerferie 2026»).
3. Trykk **Velg mappe** og velg bildemappen, eller dra mappen inn.
4. Trykk på ⭐ på bildene som skal være høydepunkter, og dra bildene for å endre rekkefølgen.
5. Huk av **Publisert** og trykk **Lagre**. Nye album er skjult til du publiserer dem.

## Lokal testing

```bash
cd worker
cp .dev.vars.example .dev.vars
npm run dev
```

Start så en enkel webserver for `site/` på port 8080 i en annen terminal:

```bash
npx http-server site -p 8080 -c-1
```

Åpne <http://localhost:8080>. Lokalt lagres bildene i en simulert R2-bøtte under `worker/.wrangler/`.

## Godt å vite

- **HEIC-bilder fra iPhone:** Bare Safari kan lese dem direkte. I Chrome/Edge får du en feilmelding. Da kan du åpne admin-siden i Safari, eller stille iPhonen inn på «Mest kompatibel» (Innstillinger → Kamera → Formater).
- **Endre passord:** Kjør `npx wrangler secret put VIEWER_PASSWORD` på nytt.
- **Ekstra beskyttelse mot gjetting:** Du kan legge til en regel for rate limiting på `/api/login` i Cloudflare-dashbordet.
