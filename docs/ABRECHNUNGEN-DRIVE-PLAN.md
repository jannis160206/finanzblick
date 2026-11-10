# Abrechnungen, Google Drive, Jahressechstel & Planungslogik – Plan

Stand: 10.11.2026 · Basis: `salary/m3-goal-tr` (`3721d91`) · **Status: wartet auf Freigabe**

Dieser Plan beschreibt Ist- und Soll-Zustand für acht Wünsche, die auf sieben Meilensteine verteilt sind:
Upload-Pop-up, gespeichertes PDF-Passwort, Google-Drive-Anbindung, Ordner-Abfrage,
„Sonderzahlung & Jahressechstel“, Vertragsvorschläge, Sparziel-/Gehaltslogik, Trade Republic und
Mittagessen-Regel. Grenzen: keine Änderung an Auth, `src/lib/import/`, `src/lib/ai/`, kein Schema ohne Migration,
keine bezahlten Dienste, keine neuen npm-Abhängigkeiten (OAuth über `fetch`, Verschlüsselung über `node:crypto`
bzw. Web Crypto).

---

## 1. Ist-Zustand

### 1.1 Abrechnungs-Upload (`payslip-import.tsx`, `payroll-taxes.tsx`)

- Der grüne Kopf-Button **„Abrechnung hinzufügen“** ist nur ein Anker auf `#payroll-import`.
- `PayslipImportPanel` enthält: Drag-and-drop-Fläche, verstecktes Datei-Input („Lohnabrechnungen als PDF
  auswählen“), Button „PDF auswählen“, aufklappbares Feld „Passwortgeschützte PDF“ mit „PDF-Passwort“ (nur im
  React-State, nie gespeichert), Importbericht, Liste „Gespeicherte Abrechnungen (n)“, „Gespeicherte ins Budget
  übertragen“ sowie die Dialoge „Gespeicherte Abrechnungen ersetzen?“ und „Lohnabrechnung entfernen?“.
- Verarbeitung `readFiles(files)`: 1–24 PDFs, je ≤ 20 MiB, seriell → `parsePayslipPdf(buffer, password?)`
  (PDF.js, im Browser mit Worker `/api/pdf-worker`) → Validierung (`payslipSchema`) → `preparePayslipMerge`
  (Dubletten/Konflikte über `payslipKey`) → `applyPayslipIncome` (Netto ins Budget des Folgemonats).
- `PayslipPasswordError` unterscheidet `password-required` und `wrong-password`; danach muss man das Passwort
  eintippen und „Mit Passwort erneut lesen“ drücken – kein Pop-up, keine Frage bei mehreren Dateien.
- Der globale Import („Importieren“ in der Kopfzeile) erkennt Lohnzettel (auch geschützte) und legt sie in die
  Inbox `useImportInbox("payslip")`, die bisher das Panel abarbeitet.
- Betroffene Tests: `payroll-taxes.test.tsx`, `payslip-security.test.tsx`, `payslip-confirmation.test.tsx`,
  `tests/payroll-workspace.spec.ts`, `tests/payslip-safety.spec.ts`, `tests/salary-settings.spec.ts`.

### 1.2 Geheimnisse, Hintergrundjobs, Auth

- **Keine Verschlüsselungshilfe vorhanden.** Gmail-App-Passwort (`mail-links/<user>.json`) und Enable-Banking-Token
  (`bank-links/<user>.json`) liegen als Klartext-JSON mit Dateirechten `0600` neben der Datenbank.
- SQLite über `node:sqlite`; Finanzstand als JSON je Benutzer mit Revision; Migrationen in
  `src/lib/automation/migration.ts` (zuletzt Version 17).
- Sitzungen: Cookie `finanzblick_session` (Produktion `__Host-…`), `HttpOnly`, `SameSite=Lax`; Routen prüfen über
  `requestSessionToken` + `database.currentUser`, Änderungen zusätzlich `requireMutationOrigin`. Kein Middleware/
  Proxy; unter `/api/auth/` gibt es `login`, `logout`, `register`, `session`. Ein neuer
  `/api/auth/callback/google` wäre erreichbar und bekäme bei der Rückleitung von Google das Sitzungscookie
  (Top-Level-GET, `Lax`) – **aber nur auf demselben Host** (`localhost` ≠ `127.0.0.1`).
- **Hintergrundjobs** laufen im separaten Worker-Prozess (`scripts/statement-worker.ts`, `npm run worker`; im
  Entwicklungsmodus startet `instrumentation.ts` ihn als Kindprozess): Statement-Queue sowie
  `startBankAutoSync` und `startMailAutoSync` (15-Minuten-Takt, 6-Stunden-Intervall je Benutzer).
- **Kontoauszüge laufen im Kontomodus bereits komplett serverseitig**: Upload (`uploadStatement`,
  `src/lib/automation/handlers.ts`) → Job → isolierter Parser im Worker (CSV/XLSX, Amex-PDF, Amex-Screenshot) →
  Finanzstand + Ergebnis gemeinsam committed → Browser erfährt es per SSE. **Lohnzettel werden dagegen nur im
  Browser gelesen.**
- Kein OAuth-/Google-Code vorhanden.

### 1.3 Sonderzahlung & Jahressechstel (Stand nach der letzten Runde)

- Karte „Sonderzahlung & Jahressechstel“ (`payroll-results.tsx`): nächste Sonderzahlung als Wertetabelle (Brutto,
  geschätzter Auszahlungsanteil netto, Lohnsteuer, Mehr-/Mindersteuer), Jahressechstel-Balken, darunter
  „Mehr Details“ mit Abrechnungsstand, Sechstel-Schätzung, Prämien-Spielraum und „Steuerbeispiel für 1.000 €“.
- „Monate“ (`payroll-months.tsx`): zwölf Zeilen mit Brutto/Netto/LSt/SV; darin „Monatliche Prognose anzeigen“
  (`payroll-details.tsx`) als zweite Liste mit laufendem Brutto, Sonderzahlung und Sechstel-Schätzung.
- Schwächen: zwei Monatslisten für dieselben Monate, viel Fließtext in den Details, Status (belegt/geschätzt)
  nur als Text-Badge, Steuerbeispiel als lange Wertetabelle.

### 1.4 Vertragsvorschläge (`src/lib/contracts.ts`, `contracts-page.tsx`)

- Erkennung wird bei jedem Aufruf neu berechnet; Gruppierung über `brandKey`, Aufteilung in Betragscluster und
  Läufe. **ID** = Marken-Schlüssel für den Hauptlauf, sonst `marke#<erster Betrag in Cent>`.
- Entscheidungen („Ist ein Vertrag“ → `confirmed`, „Kein Vertrag“ → `ignored`) werden in `state.contracts`
  **nur über die exakte ID** gefunden. „Neu erkannt“ = `status === "review"`.
- **Ursache des Wiederauftauchens**: Die ID ist instabil – neuer Betrag/Preisänderung ändert das `#Cent`-Suffix,
  ein Nebenlauf wird zum Hauptlauf (oder umgekehrt), Händler-Normalisierung ändert den Schlüssel. Dann passt die
  Entscheidung nicht mehr und der Vorschlag steht wieder unter „Neu erkannt“. Tests decken das nicht ab.

### 1.5 Sparziel-, Gehalts- und Budgetlogik

- `planGoal` (ASAP): verbraucht zuerst ausgewählte Konten, dann **100 % des freien Monatsüberschusses**, zuletzt
  „späte“ Konten (Trade Republic). Kein Reserve-Prozentsatz.
- Freier Überschuss je Monat = `monthBasis().free` = Überschuss − andere Zielraten − fester Sparkonto-Sockel
  (`SAVINGS_FLOOR` = 180 €). Kein prozentualer Sparanteil.
- Kontoregel-Text „Kontoregel: nur für …“ kommt aus `savings-goal-wizard.tsx`; Trade Republic ist seit der letzten
  Runde eine gesperrte **Ausnahme** mit „Mindestens behalten“ (Standard: Notgroschen-Ziel), gespeichert in
  `funding.exceptions`. Einen allgemeinen Behalten-Betrag je Konto gibt es nicht.
- Einkommen im Budget: `financeRows` mit `kind: "income"` (Seed: „Gehalt“, „Weitere Einnahmen“).
  `applyPayslipIncome` schreibt nur **tatsächliche** Abrechnungen (Netto → Folgemonat; getrennt nach Gehalt,
  Rufbereitschaft, Feiertagsarbeit, Sonderzahlungen) und lässt sonstige Einnahmen unberührt – daher können
  Sonderzahlungen doppelt stehen (einmal per Abrechnung, einmal von Hand in „Weitere Einnahmen/Sonstiges“).
- **Keine Gehaltsprognose fürs Budget**: Die Steuer-Prognose (`payroll-analysis.ts`, Sonderzahlungen im Juni und
  November) wird nicht in künftige Budgetmonate übernommen. Überstunden haben kein eigenes Abrechnungsfeld.

### 1.6 Trade Republic auf der Sparen-Seite

- `TradeRepublicSettings` (`settings.tsx`, auf `/sparen`) mit Feldern „TR Kontostand“, „TR Standdatum“,
  „Zinssatz p.a.“; zusätzlich `TRBalanceDialog` (`pockets.tsx`) für den Saldo. Beide schreiben `trBalances` bzw.
  `settings.interestRates`.
- Die Bank-API (Enable Banking, `mergeBankBalances`) liefert **Salden** inkl. Trade Republic, **aber keinen
  Zinssatz**. Der Zinssatz wird für TR-Zinsen im Dashboard und für den Zinshinweis im Sparziel-Dialog gebraucht.

### 1.7 Mittagessen

- `Transaction.time` (HH:mm:ss) wird bei CSV-Importen gefüllt (Revolut „Started Date“), **nicht** bei Enable
  Banking. `isLunchTime` prüft 11:00–14:00 an Werktagen (Kärntner/österr. Feiertage ausgenommen).
- Heute: Mensa/Hotspot/BIPA → Mittagessen an Werktagen (ohne Uhrzeit, jede Bank); BILLA/SPAR → Lebensmittel,
  nur bis 10 € zur Mittagszeit → Mittagessen. **„Wiener Reuther“ fehlt, Urlaubszeiträume (`holidayRanges`)
  werden nicht berücksichtigt.** Die Regel liegt in `src/lib/recurring-purpose.ts` und `src/lib/calc/index.ts`
  (nicht in `src/lib/ai/` oder `src/lib/import/`).

---

## 2. Soll-Zustand je Meilenstein

### M1 – Upload-UI bereinigen + Passwort-Pop-up (`drive/m1-upload`)

- Upload-Fläche, „PDF auswählen“, Drag-and-drop und das sichtbare Passwortfeld werden von der Seite entfernt.
  Der Bereich „Abrechnungen“ zeigt nur noch den letzten Importbericht und die gespeicherten Abrechnungen
  (inkl. Übertragen/Entfernen/Ersetzen-Dialogen – unverändert).
- Der grüne Kopf-Button heißt **„Abrechnungen hochladen“** und öffnet direkt die Dateiauswahl (PDF, mehrere).
- Die Verarbeitung wandert unverändert in einen Hook (`usePayslipUpload`), den Button, globaler Import (Inbox)
  und später der Drive-Import gemeinsam nutzen. Limits, Bericht, Dubletten- und Konfliktlogik bleiben gleich.
- **Passwort-Pop-up** (PremiumDialog; Bottom Sheet am Handy): erscheint, sobald eine Datei ein Passwort braucht
  bzw. das eingegebene/gespeicherte falsch ist. Inhalt: Dateiliste mit Status-Chips, Passwortfeld mit
  Anzeigen/Verbergen, Fehlerzustand „Passwort falsch“, Bestätigen liest die Dateien sofort neu.
- Bei mehreren geschützten Dateien: Frage **„Passwort für alle Dateien verwenden?“** (Schalter, Standard an). Aus
  → das Pop-up fragt Datei für Datei (Schritt-Dialog mit Dateiname und Fortschritt).

### M2 – Gespeichertes Passwort (`drive/m2-password`)

- Neue Einstellungs-Kategorie **„Abrechnungen“** mit Abschnitt „PDF-Passwort“: Feld mit Anzeigen/Verbergen,
  Speichern, Ersetzen, Entfernen; gespeichert wird nur der Hinweis „Passwort hinterlegt“, das Passwort wird nie
  wieder angezeigt. Verknüpfung von der Gehaltsseite; im Pop-up zusätzlich „Passwort sicher speichern“.
- **Verschlüsselung**: neue Hilfe `src/lib/server/secrets.ts` (AES-256-GCM, Zufalls-IV, Versionskennung,
  Authentifizierung). Schlüssel aus `FINANZBLICK_SECRET_KEY` (32 Byte, Base64); fehlt die Variable, erzeugt der
  Server einmalig `secret.key` (0600) neben der Datenbank. Speicherung je Benutzer in `secrets/<user>.json`
  (0600) – nie im Finanzstand, also auch nicht in Backups/Exporten.
- **Browsermodus** (ohne Server): Web Crypto AES-GCM mit nicht exportierbarem Schlüssel in IndexedDB.
- Verwendung: Jede Lohnzettel-Verarbeitung (Button, globaler Import, Drive) versucht zuerst ohne, dann mit dem
  gespeicherten Passwort; erst wenn beides scheitert, kommt das Pop-up. Der Browser holt das Passwort nur bei
  Bedarf über eine authentifizierte `no-store`-Route.

### M3 – Google Drive OAuth (`drive/m3-oauth`)

- Kategorie „Banken & Verbindungen“ erhält **„Google Drive“**: Status (verbundenes Konto über `about.get`),
  „Verbinden“, „Trennen“ (inkl. Token-Widerruf), Hinweis bei Ablauf.
- Ablauf: `POST /api/drive/connect` (Sitzung + Origin-Prüfung) erzeugt `state` und PKCE-Verifier, legt sie in ein
  kurzlebiges `HttpOnly`-Cookie (10 Min., an den Benutzer gebunden) und liefert die Google-URL
  (`scope=https://www.googleapis.com/auth/drive.readonly`, `access_type=offline`, `prompt=consent`). Rückkehr auf
  **`/api/auth/callback/google`**: prüft Sitzung, `state` und Verifier, tauscht den Code gegen Tokens, speichert
  Refresh-/Access-Token **verschlüsselt** (M2-Hilfe) in `drive-links/<user>.json` und leitet zu
  `/einstellungen#google-drive` zurück. Die Auth-Logik selbst bleibt unverändert; die Route nutzt nur die
  bestehenden Sitzungs-Helfer.
- Konfiguration nur über `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, optional `GOOGLE_REDIRECT_URI` (Standard:
  `${FINANZBLICK_ORIGIN}/api/auth/callback/google`). Ohne Variablen zeigt der Bereich „nicht eingerichtet“.
- Nur im Kontomodus (Browsermodus hat keinen Server für Tokens).

### M4 – Ordner-Abfrage (`drive/m4-polling`)

- `startDriveAutoSync` im bestehenden Worker-Prozess (neben Bank-/Mail-Sync, gleiches Muster mit
  Überlappungsschutz): alle 15 Min. Takt, je Benutzer **stündlich**; dazu „Jetzt prüfen“ in den Einstellungen.
- Ordner werden per exaktem Namen gefunden (**„AMEX Abrechnungen“**, **„Abrechnungen“**, nicht im Papierkorb);
  bei mehreren gleichnamigen Ordnern wählt man einmalig in den Einstellungen. Gelesen werden direkte Dateien des
  Ordners (Seitenweise, ≤ 20 MiB, Google-Docs-Formate übersprungen).
- **„AMEX Abrechnungen“** (PDF, CSV, XLSX) → gleiche Server-Pipeline wie ein manueller Kontoauszug-Upload
  (Job in die Statement-Queue; Erkennung, Kategorisierung, Dubletten wie gehabt) → fließt in Buchungen und
  Umsatz-Kalkulation, auch wenn kein Browser offen ist.
- **„Abrechnungen“** (PDF) → Lohnzettel-Pipeline: Der Worker lädt neue Dateien in eine private Drive-Inbox; sobald
  die App im Browser offen ist, verarbeitet sie diese automatisch mit `usePayslipUpload` (gespeichertes Passwort,
  sonst Pop-up; Konflikte über den bestehenden Ersetzen-Dialog) und meldet das Ergebnis als Hinweis. Daraus
  entstehen Lohnsteuer, SV/Abgaben und das Budget-Netto wie bei manuellem Upload.
- **Dubletten**: Register je Benutzer (Drive-Datei-ID + `md5Checksum` + Änderungszeit) – bereits verarbeitete
  Dateien werden nicht erneut geladen; geänderte Dateien laufen erneut durch, die bestehende Inhalts-Dublettenprüfung
  (`statementFingerprint`, `payslipKey`) verhindert doppelte Buchungen/Abrechnungen.
- Status in den Einstellungen: letzte Abfrage, je Ordner Anzahl neu/übersprungen/Fehler, offene Lohnzettel
  „warten auf Passwort“, letzte Fehlermeldung.

### M5 – Sonderzahlung & Jahressechstel neu (`drive/m5-sixth`)

- **Nächste Sonderzahlung** als Hauptkarte: große geschätzte Netto-Auszahlung, Monat und Status-Chip
  („geschätzt“/„belegt“), darunter drei kompakte Kennzahlen (Brutto, Lohnsteuer, Mehr-/Mindersteuer).
- **Jahressechstel** als eigene Karte: Fortschrittsbalken mit verbraucht / Rest / Überhang, Quelle als Chip
  („laut Abrechnung“ / „Bruttovergleich“), Schätzung für Dezember als Sekundärzahl.
- **Monatsübersicht Jänner–Dezember** als 12er-Kachelraster (Handy 3 Spalten, Tablet 4, Desktop 6): je Kachel
  Monat, Netto (bzw. Brutto bei Prognose), Status-Punkt belegt/geschätzt/fehlt, Marker für Sonderzahlung. Antippen
  öffnet die Monatsdetails (Popover/Bottom Sheet: laufendes Brutto, Sonderzahlung, LSt, SV,
  Jahressechstel-Schätzung). Ersetzt die bisherige Monatsliste **und** die separate „Monatliche Prognose“.
- **Steuerbeispiel** als kompakte Gegenüberstellung „+1.000 € brutto → x € netto · y € Steuer“ mit Details zum
  Aufklappen; Prämien-Spielraum als Bereichsbalken.
- Weniger Fließtext (Erklärungen in ⓘ-Tooltips), Dark Mode, 375/768/1440 px, Bewegung nur als Zustandsänderung.

### M6 – Verträge, Sparziel, Gehaltsprognose, Trade Republic, Mittagessen (`drive/m6-rules`)

**Vertragsvorschläge**

- Stabile Identität: Hauptlauf weiterhin Marken-Schlüssel; Nebenläufe über Intervall + Betragsband statt
  „erster Betrag in Cent“.
- Entscheidungen speichern zusätzlich einen Abgleich-Schnappschuss (`match: { brand, amount, interval }`,
  additiv, optional). Passt die ID nicht, wird über Marke + Intervall + Betrag (±20 %) zugeordnet; alte
  Entscheidungen ohne Schnappschuss greifen über die Marke, wenn es dort nur einen offenen Vorschlag gibt.
- „Neu erkannt“ enthält nur noch unentschiedene Vorschläge; Assistent/Hinweise nutzen dieselbe Zuordnung.

**Sparziel**

- „So schnell wie möglich“ nutzt höchstens (100 − Reserve) % des freien Überschusses; Reserve einstellbar,
  Standard **15 %**.
- **Spar-Prozentsatz**: Ein fester Anteil des positiven Monatsüberschusses (Standard **10 %**, mindestens der
  bisherige Sockel von 180 €) geht immer aufs Sparkonto und steht dem Ziel nicht zur Verfügung – im Planer und
  in der Dashboard-Aufteilung gleich.
- „Kontoregel: nur für Notfälle“ und der Ausnahme-Schalter entfallen. Stattdessen **Behalten-Betrag je Konto**
  (außer Girokonto) als globale Einstellung, im Schritt „Konten“ direkt editierbar. Was darüber liegt, darf
  **einmalig** fürs Ziel verwendet werden; angeboten werden **Sparkonto** und **Trade Republic**. Standard:
  Trade Republic = Notgroschen-Ziel, Sparkonto = 0 €. `funding.exceptions` bleibt lesbar (Kompatibilität).
- Sonderzahlungen fließen über die Gehaltsprognose in die Monatskapazität (Dezember ≈ doppelt, Jänner fast
  doppelt), auf die Reserve und Spar-Prozentsatz ebenfalls angewendet werden.

**Gehaltsprognose & Budget-Korrektur**

- Neues `src/lib/salary-forecast.ts`: Prognose je künftigem Zuflussmonat aus den Gehaltseingängen der letzten
  12 Monate (Abrechnungen → Folgemonat, sonst Gehaltsbuchungen der Bank), skaliert mit dem Erhöhungsfaktor
  (aktuelles laufendes Netto ÷ Vorjahresniveau, Sprünge im Grundgehalt erkannt). Fehlt der Vorjahresmonat,
  zählen laufendes Netto plus modellierte Sonderzahlung (Juni/November → Zufluss Juli/Dezember).
- Daraus Vorschläge für **Gehalt**, **Ø Rufbereitschaft**, **Ø Überstunden/Mehrleistungen** (laufendes Brutto über
  Grundgehalt abzüglich Rufbereitschaft und Feiertagsarbeit, netto anteilig) und **Sonderzahlungen**; doppelte
  Sonderzahlungen in „Weitere Einnahmen/Sonstiges“ werden erkannt und zur Bereinigung vorgeschlagen.
- Übernahme nur nach Bestätigung im Dialog **„Budget aktualisieren“** (alt → neu je Zeile und Monat, einzeln
  abwählbar). Tatsächliche Abrechnungen überschreiben Prognosewerte wie bisher.

**Trade Republic**

- `TradeRepublicSettings` und `TRBalanceDialog` werden entfernt. Die Sparen-Seite zeigt Saldo und Stand nur aus
  der Bank-API (read-only) bzw. einen Hinweis „Trade Republic in Banken & Verbindungen verbinden“.
- Zinssatz: aus den Zinsgutschriften der TR-Buchungen abgeleitet (Zinsen × 12 ÷ Durchschnittssaldo); ohne
  Zinsbuchungen gilt der zuletzt gespeicherte Satz (nur Anzeige).

**Mittagessen**

- Neue Regel (außerhalb von `src/lib/ai`/`src/lib/import`): **Revolut**-Buchung mit Uhrzeit **11:00–14:00**,
  **Mo–Fr** (Feiertage ausgenommen), Händler **Mensa, Wiener Reuther, BIPA, BILLA, SPAR/INTERSPAR/EUROSPAR** →
  „Mittagessen“.
- Ausnahme: Datum liegt in einem hinterlegten Urlaubszeitraum (`holidayRanges`) – dann keine automatische
  Zuordnung; das gilt auch für die bestehende Mensa/BIPA-Regel. Manuelle Zuordnungen gewinnen weiterhin.

### M7 – Feinschliff & Doku (`drive/m7-polish`)

- Fehlerbehandlung und Rückmeldungen (Drive-Fehler, abgelaufene Verbindung, falsches Passwort, Netzwerk),
  strukturiertes Logging ohne Inhalte/Token, Lade- und Leerzustände.
- `docs/ABRECHNUNGEN-DRIVE-SUMMARY.md` mit Einrichtungsanleitung (Google Cloud, Umgebungsvariablen, Testnutzer),
  Prüfergebnissen und offenen Punkten; README-Abschnitte aktualisiert.

---

## 3. Google-Einrichtung (vom Nutzer, nicht im Repository)

1. Im Projekt die **Google Drive API** aktivieren; das eigene Google-Konto als **Testnutzer** eintragen.
2. Weiterleitungs-URI muss **exakt** zum Host passen, mit dem man Finanzblick öffnet:
   - lokal entweder `FINANZBLICK_ORIGIN=http://localhost:3000` verwenden (passt zur angelegten URI) oder in der
     Console zusätzlich `http://127.0.0.1:3000/api/auth/callback/google` eintragen (Loopback-IPs sind erlaubt).
3. `GOOGLE_CLIENT_ID` und `GOOGLE_CLIENT_SECRET` in die private `.env.local` (lokal) bzw. `/etc/finanzblick.env`
   (Server) eintragen – nie ins Repository.
4. Optional `FINANZBLICK_SECRET_KEY` setzen (32 Byte Base64), sonst wird ein Schlüssel-File erzeugt.

**Einschränkungen von Google** (aus der offiziellen OAuth-Dokumentation):

- Im Status **„Testing“** laufen Refresh-Tokens für Drive-Scopes nach **7 Tagen** ab → Finanzblick zeigt dann
  „Verbindung abgelaufen – erneut verbinden“ (und eine Mitteilung). Dauerhaft ginge das nur mit veröffentlichter,
  von Google geprüfter App (`drive.readonly` ist ein eingeschränkter Scope).
- Weiterleitungs-URIs dürfen **keine öffentlichen IP-Adressen** sein. Der Server unter `https://167.233.251.240`
  kann Drive daher erst mit einer Domain nutzen; bis dahin funktioniert die Anbindung lokal (`localhost`).

---

## 4. Branches, Commits, Prüfungen

| Meilenstein | Branch (gestapelt auf `salary/m3-goal-tr`) |
|---|---|
| Plan, M1 | `drive/m1-upload` |
| M2 | `drive/m2-password` |
| M3 | `drive/m3-oauth` |
| M4 | `drive/m4-polling` |
| M5 | `drive/m5-sixth` |
| M6 | `drive/m6-rules` |
| M7 + Zusammenfassung | `drive/m7-polish` |

Nach jedem Meilenstein: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`; ein Commit je
Meilenstein. Keine neuen Abhängigkeiten.

## 5. Verifikation

- **Unit**: Verschlüsselung (Hin-/Rückweg, Manipulation erkannt, Schlüssel aus Env/Datei), OAuth (state/PKCE,
  Callback-Fehler, Refresh, `invalid_grant`), Drive-Client mit gemocktem `fetch` (Ordnersuche, Paging,
  Größenlimit), Dubletten-Register, Poller (nur neue Dateien, Fehler je Datei), Upload-Hook (mehrere Dateien,
  „für alle“, falsches Passwort, gespeichertes Passwort), Vertrags-Identität (Preisänderung, Haupt-/Nebenlauf,
  alte Entscheidungen), Planer (Reserve, Spar-Prozentsatz, Behalten-Beträge, Sonderzahlungsmonate),
  Gehaltsprognose und Budget-Vorschläge, TR-Zinssatz, Mittagessen-Regel inkl. Urlaub und Grenzen.
- **Komponenten**: Passwort-Pop-up, Einstellungen „Abrechnungen“ und „Google Drive“, Monatskacheln, Budget-Dialog,
  Sparen-Seite ohne TR-Felder.
- **E2E**: Upload über den Kopf-Button mit synthetischer geschützter PDF (375/768/1440, hell/dunkel, axe),
  Einstellungen mit gemockten Drive-Antworten; bestehende `payroll-workspace`/`payslip-safety` angepasst.
- Screenshots je Breite und Modus (nur synthetische Daten), eine Prüf- und eine Bestätigungsrunde,
  Design-Detektor, Lighthouse-Stichprobe `/gehalt-steuern`.
- Kein echter Google-Zugriff in Tests; Smoke-Test der Verbindung nur lokal mit deinen Zugangsdaten.

## 6. Risiken

| Risiko | Gegenmaßnahme |
|---|---|
| Google-Grenzen (7-Tage-Token, keine IP-Redirects) | klare Statusanzeige, Erneuern-Hinweis, Doku; Produktion erst mit Domain |
| Passwort muss für die PDF-Entschlüsselung im Browser lesbar sein | nur verschlüsselt gespeichert, Abruf nur authentifiziert und bei Bedarf, nie im Finanzstand/Export |
| Lohnzettel aus Drive brauchen einen offenen Browser | Inbox mit Statusanzeige; AMEX läuft vollständig serverseitig |
| Spar-Prozentsatz ändert die Dashboard-Aufteilung | Standard so gewählt, dass der bisherige Sockel Untergrenze bleibt; betroffene Tests gezielt angepasst |
| Neue Vertrags-IDs würden alte Entscheidungen verlieren | tolerantes Nachschlagen über Marke/Intervall/Betrag, Übergang für alte Entscheidungen |
| Gehaltsprognose mit wenig Historie ungenau | Begründung je Wert im Dialog, nur nach Bestätigung, Abrechnungen überschreiben |
| Mittagessen-Regel erfasst große Einkäufe | Revolut + Zeitfenster + Werktag; optional Betragsgrenze (siehe Annahme 12) |

## 7. Annahmen (bitte bestätigen oder korrigieren)

1. **Pop-up nur bei Bedarf**: Ungeschützte PDFs werden direkt importiert; das Pop-up erscheint, sobald eine Datei
   ein Passwort braucht und kein gespeichertes passt.
2. **Speicherort**: Passwort in neuer Einstellungs-Kategorie „Abrechnungen“; Google Drive unter „Banken &
   Verbindungen“. Ein gespeichertes Passwort wird nicht mehr angezeigt, nur ersetzt/entfernt.
3. **Verschlüsselung** serverseitig mit `FINANZBLICK_SECRET_KEY` oder automatisch erzeugtem Schlüssel-File;
   im Browsermodus Web Crypto/IndexedDB.
4. **Drive nur im Kontomodus**; AMEX vollautomatisch serverseitig, Lohnzettel automatisch beim nächsten Öffnen
   der App (mit Pop-up-Fallback).
5. **Abfrage stündlich** plus „Jetzt prüfen“; Ordner per exaktem Namen, nur direkte Dateien;
   AMEX: PDF/CSV/XLSX, Abrechnungen: PDF.
6. **Weiterleitungs-URI** aus `FINANZBLICK_ORIGIN`; lokal `http://localhost:3000` oder zusätzliche
   127.0.0.1-URI in der Console; Produktion erst mit Domain.
7. **Monatsübersicht** als Kachelraster ersetzt Monatsliste und „Monatliche Prognose“.
8. **Verträge**: alte Entscheidungen werden über die Marke übernommen, wenn eindeutig.
9. **Sparziel-Standards**: Reserve 15 %, Spar-Prozentsatz 10 % (mindestens 180 €), Behalten: Trade Republic =
   Notgroschen-Ziel, Sparkonto = 0 €; Quellen nur Sparkonto und Trade Republic (Urlaub/Motorrad bleiben
   zweckgebunden und werden nicht angeboten).
10. **Gehaltsprognose** datenbasiert (letzte 12 Monate + Erhöhungsfaktor), Fallback modellierte Sonderzahlungen;
    Überstunden = laufendes Brutto über Grundgehalt ohne Rufbereitschaft/Feiertagsarbeit; Budget nur nach
    Bestätigung.
11. **Trade Republic**: beide manuellen Eingaben entfallen; Zinssatz aus Zinsbuchungen, sonst letzter Wert.
12. **Mittagessen**: Für Revolut im Zeitfenster gilt **keine Betragsgrenze** (wie gewünscht); die bisherige
    10-€-Grenze für BILLA/SPAR bei anderen Banken bleibt.
13. **Zugangsdaten**: Ich trage Client-ID/-Secret nirgends ein; du setzt sie in `.env.local` bzw.
    `/etc/finanzblick.env` (oder gibst mir ausdrücklich frei, sie in deine lokale, git-ignorierte `.env.local`
    zu schreiben).
14. Ältere, schon vorher rote E2E-Specs werden nur angepasst, wenn diese Arbeit sie berührt.
