# Performance

Stand: M3 der Feature-Erweiterung (Branch `features/m3-performance`). Ziel war eine messbar bessere
Mobile-Performance, ohne die Datenlogik grundlegend umzubauen.

## Messmethode

- **Build**: `npm run build`, Start mit `next start` (Kontomodus, `FINANZBLICK_AUTH=true`, frische
  SQLite-Datenbank im Temp-Verzeichnis).
- **HTTPS wie im Betrieb**: Ein lokaler TLS-Proxy (`https://127.0.0.1:3100` → Next auf Port 3110) mit
  selbstsigniertem Zertifikat. Ohne HTTPS lehnt der Server Speichervorgänge wegen der Origin-Prüfung ab;
  die dadurch ausgelösten Wiederholungen hätten die Messung verfälscht.
- **Daten**: deterministisch erzeugter, rein synthetischer Datenstand mit **1.097 Buchungen** über
  24 Monate bis heute (Gehalt, Miete, Abos, Lebensmittel, Restaurants, Tanken, Shopping, Versicherungen),
  Girokonto-Stand und einem manuellen Vertrag (~200 KB). Keine echten Nutzerdaten. Der Stand wird vor der
  Messung per `PUT /api/finance` in das Testkonto geschrieben.
- **Lighthouse 12** (`npx lighthouse`), Kategorie Performance, Standard-Mobile-Profil (simuliertes
  Slow-4G, 4× CPU-Drosselung) bzw. `--preset=desktop`, jeweils **3 Läufe pro Seite, Median**.
  Anmeldung über das Session-Cookie als zusätzlicher Header.
- Vorher und Nachher wurden mit identischem Aufbau gemessen: „Vorher“ ist der Commit von M2
  (`02c0222`), in einem separaten Worktree gebaut.

## Ausgangslage und Ursachen

| Seite | Mobile | LCP | TBT | Desktop |
|---|---:|---:|---:|---:|
| `/` | 40 | 10,8 s | 10,7 s | 57 |
| `/umsaetze` | 44 | 11,4 s | 6,3 s | 55 |
| `/budget` | 41 | 12,0 s | 6,1 s | 71 |
| `/vertraege` | 45 | 10,2 s | 5,5 s | 59 |

Mit wenigen Buchungen waren die Werte früher deutlich besser; sie skalieren mit der Größe des Haushaltsbuchs.
Ein CPU-Profil (gedrosselt) zeigte die Ursachen:

1. **Späte Daten**: Im Kontomodus renderte der Server nur ein leeres Gerüst. Erst nach dem Laden des
   JavaScripts holte der Browser `/api/finance`, bereitete den Stand auf und zeigte Inhalte (LCP > 10 s).
2. **Aufbereitung auf dem Hauptthread**: Beim Laden läuft `queueLedgerReview` (Prüfliste, Händler-Reparatur,
   geteilte Urlaubskosten, geplante Einmalausgaben) über alle Buchungen.
3. **KI-Vorzuordnung bei jedem Seitenaufruf**: `autoAssignOpenReviews` prüft alle offenen Zuordnungen gegen
   die Historie – meist ohne Ergebnis, aber mit 0,3–0,6 s Rechenzeit (ungedrosselt).
4. **Automatik-Abgleich** `settleOpenReviews` lief als Reducer-Update ebenfalls auf dem Hauptthread.
5. **Dashboard-Karten** (Einblicke, Nettovermögen, Verträge, Prognose) rechneten jeweils über das ganze
   Haushaltsbuch, teils synchron im Render.
6. `calculateDashboard` lief für denselben Stand mehrfach (Server, Hydration, nach dem Laden).

## Maßnahmen

| Maßnahme | Dateien |
|---|---|
| **Server-seitiger Start-Stand im Kontomodus**: Das Layout liest den gespeicherten Stand des angemeldeten Kontos (bestehende Session, keine Änderung an der Anmeldung) und rendert die Seite damit. Große Haushaltsbücher (> 1,5 Mio. Zeichen) werden weiterhin im Browser geladen, damit das HTML klein bleibt. | `src/lib/server/account-snapshot.ts`, `src/app/(dashboard)/layout.tsx` |
| **Kein doppelter Abruf**: `AccountFinanceStorage.load()` nimmt den Server-Stand als ersten „Remote“-Stand entgegen; Revisions- und Merge-Regeln (lokale, noch nicht gespeicherte Änderungen) bleiben unverändert. | `src/lib/account-finance-storage.ts` |
| **Sofort sichtbar, aber schreibgeschützt**: Bis der Arbeitsstand geladen ist, ist der Seiteninhalt `inert` – Zahlen sind ab dem ersten Paint sichtbar, Eingaben können nicht verloren gehen. Lokaler Modus unverändert (Skelett bis zum Laden). | `src/components/app-shell.tsx`, `src/components/finance-provider.tsx` |
| **Rechen-Worker**: Ein Web Worker führt dieselben Funktionen aus wie bisher der Hauptthread – Aufbereitung beim Laden (`prepareLoadedState`), KI-Vorzuordnung (`autoAssignOpenReviews`, Web-Kategorien), Automatik-Abgleich (`settleOpenReviews`) und die Dashboard-Auswertungen. Nur echte Änderungen lösen ein State-Update aus. Ohne Worker (Server, Tests) läuft alles wie zuvor synchron. Die Logik in `src/lib/ai/` und `src/lib/import/` ist unverändert. | `src/lib/finance-compute.worker.ts`, `src/lib/finance-worker.ts`, `src/lib/finance-hydrate.ts`, `src/components/ai-review-assistant.tsx` |
| **Unveränderte Stände behalten ihre Identität**: Ergibt die Aufbereitung exakt den geladenen Stand, wird das ursprüngliche Objekt weiterverwendet – alle zustandsgebundenen Caches bleiben gültig. | `src/lib/finance-compute.worker.ts`, `src/components/finance-provider.tsx` |
| **Dashboard nur einmal berechnen**: Der Server gibt sein `calculateDashboard`-Ergebnis mit, der Worker liefert es zum aufbereiteten Stand; der Provider nutzt es statt neu zu rechnen. | `src/components/finance-provider.tsx`, `src/app/(dashboard)/layout.tsx` |
| **Dashboard-Auswertungen gebündelt im Worker**: Einblicke, Nettovermögen, Vertrags-Übersicht und Monatsprognose in einem Durchlauf je Stand, gemeinsam genutzt von allen Karten; Darstellung als React-Transition (zeitlich aufgeteilt). | `src/lib/dashboard-extras.ts`, `src/components/dashboard/use-dashboard-extras.ts`, Karten in `src/components/dashboard/`, `overview.tsx`, `finance-insights.tsx` |
| **Wechsel auf den Arbeitsstand als Transition**: Das Neu-Rendern nach dem Laden blockiert den Hauptthread nicht am Stück. | `src/components/finance-provider.tsx` |
| **Globale Suche**: Ergebnisliste wird nur bei geöffnetem Dialog berechnet. | `src/components/shell/global-search.tsx` |

**Caching**: `/api/finance` und alle Seiten bleiben `private, no-store` (Datenkonsistenz, keine
Finanzdaten in Caches); statische Chunks werden von Next mit `public, max-age=31536000, immutable`
ausgeliefert, HTML gzip-komprimiert. Der Service Worker cached bewusst nichts (Datenschutz) – daran wurde
nichts geändert. Neue Abhängigkeiten: keine.

## Ergebnis

Median aus 3 Läufen, identischer Aufbau und Datenstand:

| Seite | Mobile vorher → nachher | LCP | TBT | CLS | Desktop vorher → nachher |
|---|---|---|---|---|---|
| `/` | 40 → **76** | 10,8 s → **1,4 s** | 10,7 s → **1,1 s** | 0,00 | 57 → **100** |
| `/umsaetze` | 44 → **79** | 11,4 s → **1,4 s** | 6,3 s → **0,9 s** | 0,00 | 55 → **100** |
| `/budget` | 41 → **74** | 12,0 s → **1,4 s** | 6,1 s → **1,5 s** | 0,00 | 71 → **95** |
| `/vertraege` | 45 → **76** | 10,2 s → **1,4 s** | 5,5 s → **1,2 s** | 0,00 | 59 → **94** |

Die kleine Optimierung der globalen Suche kam nach dieser Messung hinzu und ist darin nicht enthalten.
Der jeweils erste Lauf nach dem Einspielen der Daten liegt niedriger (z. B. 61 auf `/`), weil dort der
frisch importierte Stand einmalig aufbereitet und gespeichert wird; ab dann ist der Server-Stand bereits
aufbereitet.

## Verbleibende Engpässe

- **TBT 0,9–1,5 s (Mobile)**: überwiegend React-Hydration und das Rendern großer Seiten auf gedrosselter
  CPU. Auf `/budget` kommt `monthPlanActuals` (Ist-Werte je Planzeile über alle Buchungen) hinzu, auf
  `/umsaetze` die Klassifizierung der Buchungsliste und die Abrechnung geteilter Urlaubskosten. Diese
  Ableitungen ließen sich nur mit einem Umbau der Seiten (serverseitig vorberechnete Ergebnisse oder
  Skelette für die Hauptinhalte, die den LCP verschlechtern würden) aus dem Hydrations-Render nehmen.
- **JavaScript-Umfang**: Der Haupt-Chunk mit React und dem gemeinsamen Rechenkern ist ~230 KB groß
  (unkomprimiert); Lighthouse schätzt 130 KB ungenutztes JavaScript.
- **Lokale Cache-Prüfung**: `AccountFinanceStorage` validiert beim Start den lokalen Gerätestand
  (Zod-Schema, ~50–70 ms gedrosselt) – bewusst beibehalten, weil davon die Merge-Sicherheit abhängt.
- Der Mobile-Wert von 90 wird mit großen Haushaltsbüchern daher nicht ganz erreicht; mit kleinen Ständen
  und am Desktop (94–100) sind die Ziele erfüllt.

## Reproduktion

1. `npm run build`
2. TLS-Proxy und `next start -p 3110` mit `FINANZBLICK_AUTH=true`, `FINANZBLICK_ORIGIN=https://127.0.0.1:3100`,
   `FINANZBLICK_ADMIN_PASSWORD` und einer temporären `FINANZBLICK_DATABASE_PATH` starten.
3. Anmelden (`POST /api/auth/login` mit `Origin`-Header), synthetischen Stand per `PUT /api/finance` schreiben.
4. `npx lighthouse https://127.0.0.1:3100/<route> --only-categories=performance --extra-headers=<cookie.json>
   --chrome-flags="--headless=new --ignore-certificate-errors"` (für Desktop zusätzlich `--preset=desktop`).
