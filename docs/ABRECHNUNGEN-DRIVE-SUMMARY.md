# Abrechnungen, Google Drive & Planung – Zusammenfassung

Stand: 10.11.2026 · Grundlage: `docs/ABRECHNUNGEN-DRIVE-PLAN.md`

Der Plan wurde **ohne ausdrückliche Rückmeldung** umgesetzt: Die Freigabe-Rückfrage kam mit „Nutzer nicht verfügbar – autonom weiterarbeiten“ zurück. Gearbeitet wurde deshalb mit den 14 Annahmen aus Abschnitt 7 des Plans. Jede davon lässt sich nachträglich ändern; die Annahmen stehen in der Tabelle unten.

## Meilensteine und Commits

Jeder Meilenstein ist ein eigener Commit auf einem eigenen, gestapelten Branch (Basis: `salary/m3-goal-tr`). Nach jedem Meilenstein waren `npm run typecheck`, `npm test` und `npm run build` grün.

| Meilenstein | Branch | Commit | Inhalt |
|---|---|---|---|
| Plan | `drive/m1-upload` | `e6c4b67` | `docs/ABRECHNUNGEN-DRIVE-PLAN.md` |
| M1 Upload + Passwort-Pop-up | `drive/m1-upload` | `6e9687a` | Upload-Fläche entfernt, Kopf-Button öffnet die Dateiauswahl, PremiumDialog für Passwörter |
| M2 Gespeichertes Passwort | `drive/m2-password` | `debf36c` | AES-256-GCM-Speicher (Server bzw. Browser), Einstellungsbereich „Abrechnungen“ |
| M3 Google Drive OAuth | `drive/m3-oauth` | `c72950a` | Verbinden/Trennen, PKCE + `state`, Tokens verschlüsselt |
| M4 Ordner-Abfrage | `drive/m4-polling` | `f1d300f` | Hintergrund-Abruf, Dedupe, AMEX → Auszugs-Warteschlange, Lohnzettel → Drive-Inbox |
| M5 Sonderzahlung & Jahressechstel | `drive/m5-sixth` | `384d86b` | Karten, 12er-Monatsraster, Progressive Disclosure |
| M6 Regeln & Planung | `drive/m6-rules` | `60dade9` | Verträge, Sparziel-Logik, Gehaltsprognose, Trade Republic nur per API, Mittagessen |
| M7 Feinschliff | `drive/m7-polish` | dieser Commit | Hinweis bei abgelaufener Freigabe, Logging, Rate-Limits, diese Zusammenfassung |

Gepusht wurde nichts. Für Stacked-PRs die Branches in dieser Reihenfolge pushen und jeweils gegen den Vorgänger öffnen.

## Was sich geändert hat

### M1 – Upload über den Kopf-Button
- Drag-and-drop-Fläche, „PDF auswählen“ und das sichtbare Passwortfeld sind entfernt. Der grüne Button **„Abrechnungen hochladen“** öffnet direkt die Dateiauswahl (mehrere PDFs).
- Die Verarbeitung (Limits 24 Dateien / 20 MB, Bericht, Dubletten, Ersetzen-Dialog, Budget-Netto) ist unverändert, liegt aber jetzt in einem app-weiten `PayslipUploadProvider` (`src/components/payslip-upload.tsx`). Button, zentraler Import und Drive nutzen ihn gemeinsam.
- **Passwort-Pop-up** (PremiumDialog, am Handy Bottom Sheet), nur wenn eine Datei es braucht:
  - Dateiliste mit Status, Show/Hide-Toggle, Fehler „Passwort falsch“.
  - Bei mehreren geschützten Dateien der Schalter **„Passwort für alle Dateien verwenden?“** (Standard an); aus = ein Feld je Datei.
- Test-Fixture: echte RC4-verschlüsselte PDFs (`tests/fixtures/payroll-state.ts`).

### M2 – Gespeichertes PDF-Passwort
- Einstellungen → **Abrechnungen → PDF-Passwort**: speichern, ersetzen, entfernen. Ein gespeichertes Passwort wird nie wieder angezeigt.
- **Kontomodus**:
  - Speicherung AES-256-GCM in `secrets/<id>.json` (0600).
  - Schlüssel aus `FINANZBLICK_SECRET_KEY` oder einmalig erzeugtem `secret.key` neben der Datenbank (`src/lib/server/secrets.ts`, `user-secrets.ts`).
  - Abruf über die authentifizierte `no-store`-Route `/api/payslip-password`.
- **Browsermodus**: Web Crypto mit nicht exportierbarem Schlüssel in IndexedDB.
- Jede Lohnzettel-Verarbeitung versucht zuerst ohne, dann mit dem gespeicherten Passwort. Das Pop-up meldet ein unpassendes gespeichertes Passwort und bietet „Passwort sicher speichern“ an.

### M3 – Google Drive verbinden
- Einstellungen → **Banken & Verbindungen → Google Drive** (nur Kontomodus): Status, „Mit Google verbinden“, „Erneut verbinden“ bei Ablauf, „Trennen“ mit Token-Widerruf.
- OAuth mit Scope `https://www.googleapis.com/auth/drive.readonly`, `access_type=offline`, `state` + PKCE (S256) in einem kurzlebigen, versiegelten HttpOnly-Cookie. Rückkehr über `/api/auth/callback/google`.
- Konfiguration ausschließlich über `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` und optional `GOOGLE_REDIRECT_URI`.
- Tokens liegen verschlüsselt in `secrets/<id>.json`, der Status in `drive-links/<id>.json`.

### M4 – Automatische Ordner-Abfrage
- **Takt**: Der Statement-Worker prüft alle 15 Minuten, je Konto stündlich (bei Rückstau früher). **„Jetzt prüfen“** startet sofort.
- **„AMEX Abrechnungen“** (PDF/CSV/XLSX) → dieselbe Warteschlange wie ein manueller Kontoauszug. Funktioniert auch ohne offenen Browser.
- **„Abrechnungen“** (PDF) → private Drive-Inbox. Die geöffnete App liest diese Lohnzettel mit dem normalen Import (gespeichertes Passwort, sonst Pop-up „Neu aus Google Drive“) und meldet je Datei das Ergebnis zurück. Ein manueller Upload hat immer Vorrang.
- **Deduplizierung**:
  - Register aus Drive-ID + Prüfsumme bzw. Änderungszeit (max. 5000 Einträge).
  - Geänderte Dateien laufen erneut durch; die bestehende Inhalts-Dublettenprüfung verhindert doppelte Buchungen.
  - Download-Fehler werden bis zu dreimal wiederholt; übersprungene Dateien holt **„Erneut versuchen“** zurück.
- **Mehrere gleichnamige Ordner**: Bis zur Auswahl im Einstellungsbereich wird der zuletzt geänderte gelesen.
- **Abgelehnter Access-Token**: wird einmal erneuert, bevor die Verbindung als abgelaufen gilt.
- **Einstellungen** zeigen je Ordner die Dateianzahl, Hinweise, wartende Lohnzettel, Rückstau und unter „Zuletzt verarbeitet“ die letzten Dateien mit Status.

### M5 – Sonderzahlung & Jahressechstel
- **Karten**:
  - **Nächste Sonderzahlung**: großes Netto, Status-Chip, Balken Netto · Lohnsteuer · SV, Mehr-/Mindersteuer.
  - **Jahressechstel**: verbraucht · Rest · Überhang, Quelle „laut Abrechnung“ bzw. „berechnet“, Schätzung „vorläufig“ bzw. „Spanne“.
  - **Prämien-Spielraum** mit aufklappbarem 1.000-€-Steuerbeispiel.
- **Monatsübersicht Jänner–Dezember** als Kachelraster (3/4/6 Spalten) mit belegt / geschätzt / fehlt und Sonderzahlungsmarker. Ein Klick öffnet die Monatsdetails.
- Die Berechnungen sind unverändert; nur die Darstellung ist neu.

### M6 – Regeln und Planung
- **Verträge**:
  - Jede Serie hat eine stabile Kennung (Händler, Rhythmus, Betragsband); jede Entscheidung speichert eine Momentaufnahme.
  - Einmal als „Ist ein Vertrag“ oder „Kein Vertrag“ markierte Vorschläge erscheinen nicht erneut unter „Neu erkannt“, auch nach Preisänderungen bis 20 %.
- **Sparziel**:
  - **Sparanteil** (Standard 10 % des Überschusses, mindestens 180 €) geht immer zuerst aufs Sparkonto.
  - **„So schnell wie möglich“** lässt eine **Reserve** (Standard 15 %) auf dem Konto.
  - „Kontoregel: nur für Notfälle“ ist entfernt. Je Konto außer Girokonto gibt es einen **Behalten**-Betrag; nur der Rest darf einmalig ins Ziel (Sparkonto, Trade Republic).
  - Die Planung rechnet mit der Gehaltsprognose inklusive Sonderzahlungen (Dezember/Jänner).
- **Gehaltsprognose + „Budget aktualisieren“** (Budget-Seite):
  - Grundlage sind die letzten zwölf Monate (Abrechnungen oder Gehaltseingänge), hochgerechnet auf das aktuelle Niveau.
  - Sonderzahlungen kommen aus dem Vorjahresmonat bzw. dem Gehaltsmodell; Rufbereitschaft und Überstunden sind Durchschnitte.
  - Der Dialog schlägt neue Werte für Einnahmenzeilen vor und erkennt doppelte Sonderzahlungen in „Sonstiges“. Übernommen wird nur, was ausgewählt ist.
- **Trade Republic**:
  - Die manuellen Felder (Kontostand, Zinssatz, Datum) sind entfernt. Die Sparen-Seite zeigt eine Karte nur mit Daten aus der Bankanbindung.
  - Der Zinssatz kommt aus den Zinsgutschriften (`src/lib/tr-interest.ts`) und wird von Dashboard, Planer und Assistent gemeinsam genutzt.
- **Mittagessen**:
  - Revolut-Zahlungen Mo–Fr 11:00–14:00 bei Mensa, Wiener Reuther, BIPA, BILLA und SPAR werden automatisch „Mittagessen“.
  - In gespeicherten Urlaubszeiträumen gibt es keine automatische Zuordnung; manuelle Kategorien haben Vorrang.

### M7 – Feinschliff
- Läuft die Google-Freigabe ab (Testmodus: nach 7 Tagen), erscheint **einmal pro Sitzung** ein Hinweis mit „Verbinden“. Neue Abrechnungen bleiben sonst unbemerkt aus.
- Worker-Logs sind leiser: Sie erscheinen nur bei neuen oder fehlgeschlagenen Dateien und Rückstau, mit eigenem Hinweis bei abgelaufener Freigabe. Dateinamen und Tokens werden nie geloggt.
- Die Inbox-Dateirouten haben ein Rate-Limit (600 Anfragen pro Minute und Konto).
- Die Assistenten-Texte (Sparanteil, Reserve, Zinssatz aus Gutschriften) und das README sind aktualisiert.

## Einrichtung Google Drive

1. **Google Cloud Console**:
   - Projekt anlegen.
   - Unter „APIs & Dienste“ die **Google Drive API** aktivieren.
   - OAuth-Zustimmungsbildschirm vom Typ **Extern** im Status **Testen** anlegen und das eigene Google-Konto als **Testnutzer** eintragen.
2. **Anmeldedaten → OAuth-Client-ID** vom Typ **Webanwendung** anlegen:
   - Autorisierte Weiterleitungs-URI: `http://localhost:3000/api/auth/callback/google` (lokal) bzw. `https://<deine-domain>/api/auth/callback/google`.
   - JavaScript-Ursprung: `http://localhost:3000`.
3. **Zugangsdaten** in der privaten Umgebungsdatei setzen (lokal `.env.local`, Server `/etc/finanzblick.env`), **nie** ins Repository:
   ```dotenv
   GOOGLE_CLIENT_ID="…apps.googleusercontent.com"
   GOOGLE_CLIENT_SECRET="…"
   # optional: FINANZBLICK_SECRET_KEY=<32 Byte Base64, z. B. openssl rand -base64 32>
   ```
4. **Host**: Finanzblick unter **demselben Host** öffnen wie in der Weiterleitungs-URI, weil Sitzungscookies je Host gelten. Also `http://localhost:3000` statt `127.0.0.1`, oder die 127.0.0.1-URI zusätzlich eintragen. Alternativ `FINANZBLICK_ORIGIN=http://localhost:3000` setzen.
5. **Neu starten**:
   - `npm run dev` startet Web-App und Worker gemeinsam.
   - In Produktion braucht es den Web-Dienst **und** `finanzblick-worker.service`. Der Worker führt die stündliche Abfrage aus und liest dieselbe `/etc/finanzblick.env`; nach dem Eintragen beide Dienste neu starten.
6. **Verbinden**: Einstellungen → Banken & Verbindungen → Google Drive → **Mit Google verbinden**.
7. **Ordner** in „Meine Ablage“ anlegen bzw. nutzen: **„AMEX Abrechnungen“** und **„Abrechnungen“** (exakte Namen).

**Sicherheit:**
- `secret.key` (bzw. `FINANZBLICK_SECRET_KEY`) gehört zur Sicherung dazu. Ohne ihn lassen sich gespeichertes PDF-Passwort und Drive-Tokens nicht entschlüsseln; dann einfach neu hinterlegen bzw. neu verbinden.
- Das Client-Secret wurde in diesem Chat als Datei geteilt. Es wurde nirgends gespeichert. Trotzdem wird empfohlen, es in der Google Cloud Console zu **rotieren** und nur das neue in die Umgebungsdatei einzutragen.

## Annahmen (autonom getroffen)

| Nr. | Annahme | Umsetzung |
|---|---|---|
| 1 | Pop-up nur bei Bedarf | ✓ |
| 2 | Passwort unter „Abrechnungen“, Drive unter „Banken & Verbindungen“ | ✓ |
| 3 | Serverseitige Verschlüsselung, im Browser Web Crypto | ✓ |
| 4 | Drive nur im Kontomodus; Lohnzettel beim nächsten Öffnen der App | ✓ |
| 5 | Abfrage stündlich + „Jetzt prüfen“, exakte Ordnernamen | ✓ |
| 6 | Weiterleitungs-URI aus der Finanzblick-Adresse | ✓ (`GOOGLE_REDIRECT_URI` optional) |
| 7 | Kachelraster ersetzt Monatsliste und „Monatliche Prognose“ | ✓ |
| 8 | Alte Vertragsentscheidungen über die Marke übernehmen, wenn eindeutig | ✓ |
| 9 | Reserve 15 %, Sparanteil 10 % (mind. 180 €), Behalten TR = Notgroschen-Ziel | ✓ |
| 10 | Gehaltsprognose datenbasiert, Budget nur nach Bestätigung | ✓ |
| 11 | Trade Republic ohne manuelle Eingaben | ✓ |
| 12 | Revolut-Mittagessen ohne Betragsgrenze; 10-€-Grenze bei anderen Banken bleibt | ✓ |
| 13 | Zugangsdaten nur über Umgebungsvariablen | ✓ |
| 14 | Ältere rote E2E-Specs nur anfassen, wenn betroffen | ✓ |

## Qualität

- **Gesamtlauf**:
  - `npm run typecheck`: Exit 0.
  - `npm test`: 5057 bestanden, 5 erwartet fehlschlagend, 3 übersprungen (vorher 4968).
  - `npm run build`: Exit 0. Die Build-Warnungen in `src/lib/ai/logo-finder.ts` bestanden schon vorher.
- **Neue Tests**: Verschlüsselung, Secret-Speicher, Passwort-Route, OAuth, Drive-Client, Inbox, Sync (Dedupe, Paginierung, Rückstau, Wiederholung, Ordnerwahl, Token-Erneuerung), Drive-Routen, Upload-Provider (Batch-Ergebnisse, Vorrang manueller Uploads), Inbox-Verarbeitung, Einstellungsbereiche, Monatsraster und Karten, Verträge, Trade-Republic-Zins, Mittagessen, Gehaltsprognose, Budget-Korrekturen und Sparziel-Planer.
- **E2E (Playwright)**, bestanden:
  - `salary-settings.spec.ts` in beiden Modi: Gehaltsseite, Einstellungen, Passwort-Dialog, gespeichertes Passwort, Sparziel mit Trade Republic, Bank-Logos, Google Drive (375/768/1440 px, hell/dunkel, axe).
  - `payroll-workspace.spec.ts`: Import echter PDFs, Dubletten, Monatskacheln bei 320/390/1440 px.
- **Bereits vorher rote E2E-Specs** schlagen identisch fehl. Das wurde gegen den Stand vor M6 nachgeprüft; die Ursache sind veraltete Selektoren aus der Zeit vor dem UI-Umbau.
  - `seasonal-theme.spec.ts`, `ux-cut.spec.ts` (Browsermodus);
  - `pockets-workspace.spec.ts`, `budget-workspace.spec.ts`, `savings-transfer-status.spec.ts`, `settings-design.spec.ts`, mobiler Teil von `profile.spec.ts` (Kontomodus).
- **Hinweis zu Kontomodus-E2E**: Viele Specs in einem Lauf lösen das Login-Rate-Limit aus („Zu viele Versuche“). Deshalb in kleineren Gruppen mit jeweils frischer Test-Datenbank ausführen.

## Offene Punkte und Grenzen

- **Produktion**: Google erlaubt als Weiterleitungs-URI keine öffentliche IP-Adresse. Auf dem Server braucht es eine Domain (z. B. über einen Reverse Proxy).
- **Testmodus**: Freigaben laufen nach 7 Tagen ab, und nur Testnutzer können sich verbinden. Dauerhaft geht das nur mit veröffentlichter App. `drive.readonly` ist ein eingeschränkter Scope; die Veröffentlichung verlangt eine Google-Prüfung.
- **Lohnzettel aus Drive** brauchen eine geöffnete App, weil Lohnzettel nur im Browser gelesen werden. AMEX-Dateien laufen dagegen vollständig serverseitig.
- **Passwortgeschützte AMEX-PDFs** werden vom Server-Parser nicht entschlüsselt (die Import-Logik in `src/lib/import/` bleibt bewusst unverändert). Der Auszugs-Import meldet sie im Uploadstatus als nicht lesbar. Eine entsperrte Kopie im Ordner wird als neue Datei übernommen.
- **Gleichzeitiger Abruf** von Worker und „Jetzt prüfen“ ist nur innerhalb eines Prozesses gesperrt. Doppelte Übernahmen verhindert die Inhalts-Dublettenprüfung.
- **Bestehende Klartext-Secrets** der Mail- und Bankanbindung wurden nicht angefasst (außerhalb des Umfangs). Sie ließen sich mit `src/lib/server/secrets.ts` nachziehen.
- **Bereits vorher rote E2E-Specs** (siehe oben) sollten in einem eigenen Schritt an das neue UI angepasst werden.
- `src/lib/import/statements.test.ts`: Nur eine Testerwartung wurde an die neue Mittagessen-Regel angepasst (Revolut SPAR 12:00 → Mittagessen). Die Import-Logik ist unverändert.
