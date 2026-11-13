# Scamcrobat

Svobodný (AGPL-3.0) prohlížeč PDF a nástroje pro práci s PDF – bez předplatného.
Běží jako desktopová aplikace pro Windows (lze nastavit jako výchozí program pro `.pdf`)
i jako webová stránka; obě verze sdílí stejný kód.

## Co umí (verze 0.2)

- otevření PDF dvojklikem, z dialogu (Ctrl+O) nebo přetažením do okna
- plynulé zobrazení všech stránek, náhledy stránek a záložky (osnova dokumentu)
- zoom tlačítky, Ctrl+kolečkem (kolem kurzoru), „na šířku“ (Ctrl+2), „celá stránka“ (Ctrl+0), 100 % (Ctrl+1)
- hledání v textu (Ctrl+F, Enter/F3 další výsledek, Shift+F3 předchozí)
- výběr textu myší (dvojklik vybere slovo) a kopírování (Ctrl+C)
- **export stránek do JPG / PNG / WebP** (Ctrl+E) – volba DPI, kvality, rozsahu stránek
  a názvů souborů bez diakritiky pro web
- **uspořádání stránek** (tlačítko „Uspořádat stránky“): otáčení, mazání, přeskládání
  přetažením, vložení stránek z jiného PDF (i přetažením souboru přímo mezi stránky),
  Zpět/Znovu (Ctrl+Z / Ctrl+Y)
- **sloučení více PDF do jednoho** (na úvodní obrazovce nebo „Vložit PDF“)
- **rozdělení PDF** po stránkách, po N stránkách nebo podle rozsahů a **extrakce** vybraných stránek
- uložení (Ctrl+S) a Uložit jako (Ctrl+Shift+S); záložky, metadata a formuláře původního
  dokumentu zůstávají zachované, upozornění na neuložené změny při zavírání
- dokumenty chráněné heslem
- světlý i tmavý vzhled podle nastavení systému

## Spuštění pro vývoj

Potřeba je [Node.js](https://nodejs.org/) 22+.

```bash
npm install
npm run dev          # webová verze na http://localhost:5173
npm run dev:app      # desktopová verze (Electron) s živými změnami
npm run app          # desktopová verze z produkčního buildu
```

Pokud se při `npm install` nestáhl Electron (npm 12 blokuje instalační skripty),
spusťte jednou `node node_modules/electron/install.js`.

## Sestavení

```bash
npm run build        # webová verze do složky dist/ (stačí nahrát na libovolný statický hosting)
npm run dist         # instalátor pro Windows do složky release/
```

Instalátor zaregistruje Scamcrobat jako program pro `.pdf`. Windows 11 nedovolí aplikacím
nastavit se jako výchozí samy, takže po instalaci: **Nastavení → Aplikace → Výchozí aplikace →
Scamcrobat → .pdf**, případně pravým tlačítkem na PDF → Otevřít v programu → Zvolit jinou aplikaci
→ Scamcrobat → Vždy.

Instalátor zatím není digitálně podepsaný, proto Windows SmartScreen při prvním spuštění
zobrazí varování („Další informace → Přesto spustit“).

## Architektura

```
electron/        hlavní proces desktopové aplikace (okna, dialogy, zápis souborů)
  main.js        vlastní protokol app://, jedna instance, otevírání souborů z příkazové řádky
  preload.cjs    úzký most mezi oknem a systémem (okno nemá přístup k Node.js)
src/
  engine/        PDF jádro: MuPDF (WebAssembly) ve Web Workeru + fronta vykreslování
  viewer/        virtualizované zobrazení stránek, zoom, výběr textu, zvýraznění
  components/    nástrojová lišta, postranní panel, dialogy
  export/        export do obrázků
  organize/      uspořádání stránek, slučování a rozdělování PDF
  platform.ts    rozdíly desktop × web (dialogy, ukládání souborů)
scripts/         vývojový server, generování ikon a testovacího PDF
```

PDF vykresluje [MuPDF](https://mupdf.com/) od Artifexu (AGPL-3.0) – stejné jádro jako
SumatraPDF. Běží ve Web Workeru, takže rozhraní nezamrzá ani u velkých dokumentů;
vykreslují se jen stránky, které jsou vidět.

Úpravy stránek jsou nedestruktivní: organizér pracuje jen se seznamem „stránka X ze souboru Y,
otočená o Z°“ a skutečné PDF se sestaví až po kliknutí na Hotovo. Základem je čerstvá kopie
původního dokumentu, do které se stránky z jiných souborů „naroubují“ a pak se vše
přeskládá – proto zůstanou záložky, metadata, odkazy i formuláře. Ukládání na desktopu jde
přes dočasný soubor, takže při chybě (soubor otevřený jinde, plný disk) originál nepoškodí.

Automatický test desktopové verze: `SCAMCROBAT_SMOKE_SHOT=snimek.png` (+ volitelně
`SCAMCROBAT_SMOKE_SCRIPT=skript.js`, který se spustí v okně) – aplikace po načtení uloží
snímek okna a skončí.

Pomocné skripty v Pythonu (vyžadují `pip install pymupdf pillow`):

```bash
python scripts/make-icons.py      # ikony z public/logo.svg a build/file-pdf.svg
python scripts/make-test-pdf.py   # test/fixtures/sample.pdf
python pdf2jpg.py PDF             # jednorázový převod složky PDF do JPG z příkazové řádky
```

## Plán

| Funkce | Náročnost |
|---|---|
| ~~Spojování, rozdělení, mazání a otáčení stránek + uložení PDF~~ | hotovo v 0.2 |
| Tisk, otáčení zobrazení, klikací odkazy | malá |
| Karty pro více otevřených dokumentů | malá |
| Sloučení záložek ze všech slučovaných PDF | malá |
| Obrázky → PDF, komprese PDF | střední |
| Anotace (zvýraznění, poznámky) a vyplňování formulářů | větší |
| Vložení obrázku podpisu | střední |
| OCR naskenovaných dokumentů | větší |
| Úprava existujícího textu | velmi velká |

## Licence

[GNU AGPL-3.0 nebo novější](LICENSE). MuPDF © Artifex Software, Inc., AGPL-3.0.
