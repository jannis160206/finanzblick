# Gehalt & Steuern, Einstellungen und Bank-Logos – Plan

Status: **wartet auf Freigabe**. Vor der Freigabe wird kein Code geschrieben.

Kurzfassung: Die Einstellungen werden zu einem aufgeräumten „Kontrollzentrum“ mit Kategorien und kompakten
Zeilen statt langer Panels. Banken bekommen überall ein Logo, aus den Daten der Bankanbindung bzw. einer selbst
gehosteten Logo-Suche, lokal gespeichert und mit Initialen als Fallback. „Gehalt & Steuern“ beginnt mit einem großen
**Brutto → Netto**-Balken, auf dem Netto, Lohnsteuer und Sozialversicherung stehen, darunter der Jahresverlauf;
Details stecken in aufklappbaren Bereichen. In der Sparziel-Verteilung lässt sich **Trade Republic** als bewusste
Ausnahme von der Kontoregel einbeziehen.

---

## 1. Ist-Zustand

### 1.1 Einstellungen (`/einstellungen`)

- Route `src/app/(dashboard)/einstellungen/page.tsx`, Komponente `Settings` (`src/components/settings.tsx`, 219 Zeilen).
  Überschrift „Profil & Einstellungen“ (Kontomodus) bzw. „Einstellungen“.
- Aufbau: links (ab 1024 px, sticky) ein Suchfeld und die Navigation `Einstellungsbereiche` mit Gruppen-Überschriften,
  auf kleineren Bildschirmen dieselben Links als horizontal scrollende Leiste. Rechts **eine lange Seite** mit allen
  Bereichen als `SettingsSection`-Panels (Icon-Kachel, Titel, Beschreibung, Rahmenlinie, Inhalt). Aktiver Bereich per
  `IntersectionObserver`, Sprungziele per Hash.
- Reihenfolge (`src/components/settings-sections.ts`):

  | Gruppe | Bereich | Anker | Inhalt |
  |---|---|---|---|
  | Konto | Profil (nur Kontomodus) | `#profil` | `AccountProfileSettings`: Name, Avatar, Abmelden u. a. |
  | Verbindungen | Bankverbindung (nur Kontomodus) | `#bankverbindung` | `BankConnections` (361 Zeilen) |
  | Verbindungen | E-Mail-Bestellungen (nur Kontomodus) | `#email` | `MailConnection` |
  | App | Erscheinungsbild | `#jahreszeit` | Thema, Akzentfarbe, Saison, Vorschau, „Einstellungen speichern“ |
  | App | Klänge | `#klaenge` | Interaktionsklänge, Lautstärke, „Klang testen“ |
  | App | Benachrichtigungen | `#benachrichtigungen` | Push-Erlaubnis und Schalter |
  | App | Sichtschutz | `#sichtschutz` | Sichtschutz-Schalter |
  | Daten | Sicherung | `#sicherung` | Excel-Export/-Wiederherstellung, Sicherungsalter, Konto-Synchronisierung |
  | Daten | Gefahrenzone | `#gefahrenzone` | „Alle Buchungen entfernen“ |

- Die globale Suche springt auf `/einstellungen#<anker>` (`src/components/shell/global-search.tsx:144-157`).
- Schwächen: alle neun Bereiche gleich gewichtet untereinander (viel Scrollen, die Gefahrenzone steht in derselben
  Reihe wie die Farbwahl); jede Sektion trägt Icon-Kachel, Beschreibung und Rahmen, das wirkt schwer und textlastig;
  auf dem Handy gibt es keine Übersicht, nur eine abgeschnittene Link-Leiste; Einstellungen zeigen ihren aktuellen
  Wert erst nach dem Hinscrollen.
- Tests: `settings.test.tsx` erwartet alle Bereiche als `region` auf einer Seite und prüft, dass „Sparziele“ und
  „Trade Republic“ nicht mehr dort stehen. E2E: `a11y`, `dashboard`, `followup-patch` (Region „Sicherung“,
  „Exportieren“), `interaction-sounds` („Interaktionsklänge“, „Klang testen“, „Einstellungen speichern“),
  `categories-acceptance`, `settings-design`, `profile`.

### 1.2 Banken und Bankanbindung

- Anbieter: **Enable Banking** (bevorzugt) und **XS2A/Tink** als Alternative (`src/lib/banking/sync.ts`,
  `enable-banking.ts`, `xs2a.ts`; API `src/app/api/bank/route.ts`, Rückruf `/api/bank/callback`).
- Hinzufügen: Länderwahl `Land der Bank` (AT/DE), bei Enable Banking ein Textfeld `Bank auswählen` mit
  `<datalist>` (Platzhalter „Bank suchen, z. B. Raiffeisen“), bei XS2A ein optionales Feld `BIC der Bank`, dann
  „Bank verbinden“ (Weiterleitung zur Bank bzw. eingebettetes XS2A-Widget im Dialog „Bank verbinden“).
- **Die Bankliste von Enable Banking enthält bereits eine Logo-URL** (`ebAspspSchema.logo`), und `bankChoices()`
  gibt sie als `logo` weiter. Die Oberfläche nutzt nur den Namen; ein `<datalist>` kann ohnehin keine Bilder zeigen.
- Bestehende Verbindungen: zwei Buchstaben als Kachel, Bankname, Testmodus-Hinweis, Status („Automatischer Abruf
  aktiv“, Freigabe bis, zuletzt geprüft), Warnung bei bald ablaufender Freigabe, Symbol-Buttons
  `<Bank>: Freigabe erneuern` und `<Bank> trennen`, Hauptkonto mit IBAN, Ziel-Pocket und Saldo, weitere Konten
  eingeklappt, Details im Tooltip.
- Banknamen sind freie Texte ohne zentrales Verzeichnis: `Raiffeisen`, `Raiffeisenbank Kärnten`, `Revolut`, `Amex`,
  `Trade Republic`, `PayPal`, `Andere Bank` sowie Namen aus der Bankanbindung. Normalisierung gibt es nur punktuell
  (`accounts.ts`, `net-worth-parts.ts`).
- Weitere Stellen mit Banken, überall nur als Text: Pocket-Karten auf `/sparen` („Revolut · Alltagspockets“,
  Trade Republic beim Notgroschen), Nettovermögen/Konten, Dialog „Kontostand aktualisieren“ (Trade Republic),
  globaler Import (Bank-, Amex-, PayPal-Auszüge), Kontoauszug-Prüfung, Konto/Pocket-Filter und Buchungsdetails in den
  Umsätzen, Konto-Angaben in Vertrags- und Sparziel-Dialog.
- Logo-Infrastruktur für Händler ist vorhanden und selbst gehostet: Suche über Wikidata, offizielle Website und
  OpenStreetMap (`findMerchantLogo`), Umwandlung in PNG (`logoPngFromImage`), Ablage als Datei, Auslieferung über
  `/api/merchants/[id]/logo` mit privatem Caching. Ein Bank-Logo-Verzeichnis gibt es nicht; unter `public/` liegen
  keine Bilder. `next.config.ts` setzt keine Content-Security-Policy.

### 1.3 Gehalt & Steuern (`/gehalt-steuern`)

- Route `src/app/(dashboard)/gehalt-steuern/page.tsx` → `PayrollTaxes` (`payroll-taxes.tsx`, 147 Zeilen).
- Reihenfolge heute:
  1. Kopf mit `Steuerjahr`, optional `Dienstverhältnis` (Gruppe `Abrechnungsauswahl`) und Link „Abrechnung hinzufügen“.
  2. `PayrollCoverage`: Hinweise zu fehlenden Monaten, Schätzungen, ungeklärter Sechstel-Zuordnung.
  3. Raster: links `PayrollResults` (266 Zeilen) – **„Nächste Sonderzahlung“** (Brutto, geschätztes Netto, Lohnsteuer,
     Mehr-/Mindersteuer), darunter eingeklappt „Mehr Details“ mit Jahressechstel-Abrechnungsstand,
     Jahressechstel-Prognose, Prämien-Spielraum und „Steuerbeispiel für 1.000 €“; rechts dauerhaft das Importfeld
     `PayslipImportPanel` (Region „Lohnabrechnungen importieren“, „PDF auswählen“, gespeicherte Abrechnungen).
  4. `PayrollDetails` (97 Zeilen): eingeklappt „Monatliche Prognose anzeigen“ mit Monatskarten
     (`<Monat> Laufendes Brutto`, `Sonderzahlung`, `Jahressechstel`).
  5. `TaxFolderPanel`: Steuer-Mappe mit absetzbaren Belegen.
- Schwächen: Die wichtigsten Zahlen eines Monats (Brutto, Netto, Lohnsteuer, SV) stehen nirgends auf einen Blick;
  die Seite beginnt mit der *nächsten Sonderzahlung*. Keine Visualisierung, kein Vergleich zum Vormonat. Viel
  Fließtext. Das Importfeld nimmt dauerhaft eine Spalte ein, auch wenn alle Abrechnungen vorhanden sind.
- Die frühere Karte zur manuellen Jahressechstel-Eingabe (`AnnualSixthCard`) ist nicht mehr eingebunden; das
  Jahressechstel kommt aus den Abrechnungen.

### 1.4 Vorhandene Daten zu Gehalt, Steuern und Abgaben

| Quelle | Inhalt |
|---|---|
| `payslips[]` (`src/lib/payslip-schema.ts`) | je Monat und Dienstverhältnis: laufendes Brutto, Sonderzahlung brutto (Pflicht); optional Netto, laufende SV und Lohnsteuer, SV und Lohnsteuer auf Sonderzahlungen, LSt-Bemessungsgrundlage, Jahressummen bis zum Monat, Grundgehalt, Rufbereitschaft, Feiertagsarbeit, Akonto, Auszahlung, gemeldetes und verbrauchtes Jahressechstel |
| `payrollForecasts[]` | Prognose je Monat: laufendes Brutto, Sonderzahlung, optional Bemessungsgrundlage und SV |
| `analyzePayroll` (`src/lib/payroll-analysis.ts`) | Monats- und Jahresprognose, Lohnsteuer-Schätzung, Jahressechstel mit Überhang, fehlende Nachweise, Prämien-Spielraum, Steuerbeispiel |
| `calculateAnnualSixth` (`src/lib/annual-sixth.ts`) | Jahressechstel, Rest, Überhang, Kontrollsechstel, Freigrenze |
| Steuer-Mappe (`src/lib/tax-folder.ts`) | absetzbare Belege nach Kategorien |

- Vergleich zum **Vormonat** ist direkt möglich (zwei Abrechnungen). Ein **Vorjahresvergleich** geht erst ab 2027,
  weil Abrechnungen nur für 2026/2027 gespeichert werden; bis dahin wird er nicht angezeigt.
- Einzelne Abzüge wie Betriebsratsumlage, Gewerkschaft oder e-card sind nicht als Felder gespeichert. Sie lassen
  sich nur als **„Sonstige Abzüge“** = Brutto − Netto − Lohnsteuer − SV ausweisen, wenn alle vier Werte belegt sind.
- Eine endgültige Jahres-Einkommensteuer bzw. Arbeitnehmerveranlagung wird nicht berechnet und bleibt außen vor.

### 1.5 Trade Republic in der Sparziel-Verteilung

- Trade Republic **ist der Notgroschen**: Der Bankabruf schreibt den TR-Saldo in `trBalances`
  (`mergeBankBalances`), der Notgroschen-Stand kommt daraus, Zinsen laut `settings.interestRates`.
- Im Sparziel-Dialog (Schritt „Konten“) erscheint er als „Notgroschen“ und ist gesperrt, weil die Standard-Kontoregel
  „nur für Notfälle“ lautet (`accountsWithRules` → `sourceAllowed`). Eine bewusste Ausnahme ist nicht möglich.
- Die übrige Technik trägt bereits: Planzeilen für Kern-Pockets werden als Extra-Betrag des Ziels und Entnahme im
  Monatsplan gebucht (`withGoalPlan`), die Projektion senkt den Notgroschen ab diesem Monat.
- Das Notgroschen-Ziel `settings.emergencyTarget` ist vorhanden.

### 1.6 Nebenbefunde

- `TradeRepublicSettings` in `settings.tsx` wird nicht mehr gerendert; README Zeile 248 verweist noch auf
  „Einstellungen → Trade Republic“.
- Mehrere ältere E2E-Specs zielen auf Stände vor dem UI-Umbau (bekannt aus den letzten Runden).

---

## 2. Soll-Zustand

### 2.1 Gestaltungsrichtung

- **Bedienoberfläche, kein Showcase**: Lesbarkeit, Ruhe und schnelle Orientierung vor Effekten. Die bestehende
  Gestaltung (Tokens in `docs/DESIGN-TOKENS.md`, Premium-Dialoge, Karten, Dunkelmodus) bleibt die Grundlage; keine
  neuen Schriften oder Farben.
- **Ein Fokuspunkt pro Seite**: in den Einstellungen die Übersicht mit den aktuellen Werten, bei Gehalt & Steuern
  der Brutto → Netto-Balken.
- **Textbudget**: Bereichsköpfe ohne Beschreibung; Erklärungen als Info-Tooltip (ⓘ) oder in aufklappbaren
  Bereichen. Fehlermeldungen und Warnungen bleiben sichtbar.
- **Eine bewusste Bewegung**: der Balken baut sich beim ersten Anzeigen einmal von links auf; sonst nur die
  vorhandenen Übergänge. „Bewegung reduzieren“ wird respektiert.

### 2.2 M1 – Einstellungen

**Struktur: Kategorien statt einer langen Seite.**

| Kategorie | Bereiche | Zusammenfassung in der Übersicht (Beispiele) |
|---|---|---|
| Konto *(nur Kontomodus)* | Profil | Name, angemeldet als |
| Banken & Verbindungen *(nur Kontomodus)* | Bankverbindung, E-Mail-Bestellungen | Logos der verbundenen Banken, „2 Banken · zuletzt vor 2 Std.“ |
| Darstellung | Erscheinungsbild, Klänge | „Dunkel · Mint · Klänge an“ |
| Mitteilungen & Privatsphäre | Benachrichtigungen, Sichtschutz | „Push an · Sichtschutz aus“ |
| Daten | Sicherung, Gefahrenzone | „Letzte Sicherung vor 3 Tagen“ |

**Layout je Breite**

- **ab 1024 px**: zweispaltig. Links Suche und Kategorien (Icon, Name, kleine Zusammenfassung), rechts nur die
  gewählte Kategorie mit ihren Bereichen. Die Gefahrenzone steht am Ende von „Daten“, abgesetzt.
- **unter 1024 px**: Übersicht als gruppierte Liste (Icon, Name, aktueller Wert, Pfeil); Antippen öffnet die
  Kategorie mit Zurück-Schaltfläche. Der Browser-Zurück-Knopf führt zurück zur Übersicht.
- **Bereiche als Zeilen** (neue `SettingsGroup`/`SettingsRow`): Bezeichnung links, Steuerung bzw. Wert rechts,
  optional ⓘ-Tooltip, feine Trennlinien statt Panel-im-Panel. Bestehende Steuerungen (Themenwahl, Schalter,
  Export, Sicherung, Bankliste) werden eingesetzt, ihre Funktionen bleiben unverändert.
- **Suche** findet über alle Kategorien und zeigt Treffer als Zeilen „Kategorie › Bereich“; Escape leert sie.
- **Deep Links bleiben gültig**: `/einstellungen#bankverbindung` öffnet „Banken & Verbindungen“ und scrollt zum
  Bereich; zusätzlich `?bereich=<kategorie>`. Die globale Suche funktioniert unverändert.
- Lokaler Modus (ohne Konto) zeigt nur die Kategorien ohne Konto-Bezug.

**Bankverbindung neu**

- Kopf: „Bank hinzufügen“ und „Jetzt abrufen“ mit „zuletzt vor …“.
- Je Verbindung eine Zeile mit **Bank-Logo**, Name und Status-Chip („Aktiv“, „Pausiert“, „Freigabe endet in
  9 Tagen“); darunter die Konten mit maskierter IBAN, Ziel-Pocket und Saldo. Seltene Aktionen (Freigabe erneuern,
  Trennen) in einem Menü; die bisherigen Beschriftungen `<Bank>: Freigabe erneuern` und `<Bank> trennen` bleiben,
  Trennen fragt nach.
- **„Bank hinzufügen“ als Premium-Dialog** (Modal bzw. Bottom Sheet): Land als Segmented Control (AT/DE),
  Suchfeld mit Liste (Combobox) **mit Logo vor jedem Banknamen**, bereits genutzte Banken oben, Tastatur
  (Pfeile, Enter), Lade-, Leer- und Fehlerzustand; danach „Bank verbinden“. Bei XS2A bleibt das BIC-Feld.
  Beschriftungen `Land der Bank`, `Bank auswählen`, `Bank verbinden` bleiben für die Tests.

### 2.3 Bank-Logos

**Quelle – Entscheidung:**

1. **Logo aus der Bankanbindung**: Enable Banking liefert pro Bank eine Logo-URL. Sie wird **serverseitig**
   abgerufen, in PNG umgewandelt (`logoPngFromImage`) und lokal gespeichert. Der Browser lädt Logos immer von der
   eigenen App, nie von Dritten.
2. **Selbst gehostete Suche** für Banken ohne Anbindung (Raiffeisen, Revolut, Amex, Trade Republic, PayPal …):
   ein kleines lokales **Bankverzeichnis** (`src/lib/banks/registry.ts`: Name, Aliase, BIC-Präfixe, offizielle
   Domain) und die vorhandene Logo-Suche (Wikidata → offizielle Website), aufgerufen ohne KI und in einem eigenen
   Ordner. Die KI-Logik in `src/lib/ai/` wird nicht geändert, nur aufgerufen.
3. **Fallback**: Monogramm (Initialen) in einer aus dem Namen abgeleiteten, ruhigen Farbe; im Verzeichnis auch eine
   gepflegte Markenfarbe je Bank, wenn bekannt.

*Warum nicht Clearbit oder Brandfetch?* Die Clearbit Logo API ist für neue Nutzer eingestellt (Hinweis auf
clearbit.com, Stand heute). Brandfetch bzw. logo.dev sind externe Dienste mit API-Schlüssel, und der Browser würde
bei jedem Seitenaufruf Banknamen an Dritte senden. Das widerspricht „selbst gehostet“. Logo-Dateien werden
**nicht ins Repository** übernommen (Markenrechte); sie entstehen zur Laufzeit im Datenverzeichnis wie die
Händler-Logos.

**Technik**

- `GET /api/banks/logo?name=<Bank>` (bzw. `&aspsp=<Name>&country=<AT>`): löst den Namen über Verzeichnis und
  zwischengespeicherte Bankliste auf und liefert PNG mit Versions-Cache; unbekannt → 404, die Oberfläche zeigt das
  Monogramm. **Keine frei wählbaren URLs** (Schutz vor SSRF): abgerufen werden nur Logo-URLs aus der eigenen
  serverseitigen Enable-Banking-Liste und Domains aus dem Verzeichnis; Größen- und Zeitlimits wie bei den
  Händler-Logos. Fehlschläge werden gemerkt, damit nicht bei jedem Aufruf neu gesucht wird.
- `BankLogo` (Client-Komponente): rund bzw. leicht abgerundet, Größen `xs` 16 px / `sm` 24 px / `md` 32 px /
  `lg` 40 px, weißer Untergrund mit feiner Kontur (wichtig im Dunkelmodus), Monogramm bis das Bild geladen ist,
  `alt` leer, weil der Name daneben steht.
- **Einsatzorte**: Bankverbindungen und Bank-hinzufügen-Dialog; Pocket- und Kontokarten sowie Nettovermögen auf
  `/sparen`; Dialog „Kontostand aktualisieren“; globaler Import (Quellen); Konto/Pocket-Filter und Buchungsdetails in
  den Umsätzen; Kontoauswahl im Vertrags- und Sparziel-Dialog. Native `<select>`-Listen können keine Bilder
  zeigen: Dort steht das Logo neben dem gewählten Wert, die Liste selbst bleibt nativ.

### 2.4 M2 – Gehalt & Steuern

**Reihenfolge der Seite**

1. **Kopf**: Titel, Jahr und Dienstverhältnis als kompakte Auswahl, Monatswahl (Standard: letzte Abrechnung),
   „Abrechnung hinzufügen“. Hinweise zur Abdeckung („2 Monate fehlen“) als kleiner Chip mit Details im Popover.
2. **Brutto → Netto (Fokuspunkt)**: ein breiter, gestapelter Balken von Brutto bis Netto mit den Segmenten
   **Netto · Lohnsteuer · Sozialversicherung · Sonstige Abzüge** (Farben aus den Chart-Tokens, mit Beschriftung,
   nicht nur Farbe). Darüber groß **Netto**, daneben Brutto, Lohnsteuer und SV mit Anteil in %. Vergleichs-Chips
   „+52 € zum Vormonat“, ab 2027 „Vorjahr“. Sonderzahlungsmonate zeigen laufend und Sonderzahlung getrennt.
   Fehlende Werte erscheinen als „nicht auf der Abrechnung“ statt als 0.
3. **Jahr bisher**: Summen Brutto, Netto, Lohnsteuer, SV, durchschnittlicher Abzugssatz; darunter eine
   **Monatsleiste** (12 schmale gestapelte Säulen, Sonderzahlungen markiert, Prognosemonate blass, Klick wählt den
   Monat). Selbst gebaut mit CSS/SVG plus Tabelle für Screenreader, keine Chart-Bibliothek nötig.
4. **Sonderzahlung & Jahressechstel**: Karte „Nächste Sonderzahlung“ (Brutto, Netto, Steuer) und ein
   Fortschrittsbalken „Jahressechstel: verbraucht x von y, Rest z“ (Überhang rot). Details – Abrechnungsstand,
   Prognose, Prämien-Spielraum, Steuerbeispiel – aufklappbar, alle Inhalte bleiben erhalten.
5. **Monate**: kompakte Monatsliste (Brutto, Netto, Steuer, SV, belegt/geschätzt) statt Kartenraster, Zeilen
   aufklappbar; die bisherige Monatsprognose bleibt hier enthalten.
6. **Abrechnungen**: Liste der gespeicherten Abrechnungen und das Importfeld. Ohne Abrechnungen ist der Import der
   Startpunkt der Seite (gestalteter Leerzustand mit Ablagefläche).
7. **Steuer-Mappe**: unverändert in der Funktion, im neuen Kartenstil, eingeklappt mit Summe.

- Neues reines Hilfsmodul `src/lib/payroll-overview.ts`: Aufschlüsselung eines Monats, Vormonat bzw. gleicher Monat
  im Vorjahr, Jahressummen, Anteile; alles aus vorhandenen Abrechnungen und Prognosen, keine neue Steuerlogik.
- Erhalten bleiben: Regionen „Steuer nächste Sonderzahlung“, „Jahressechstel Abrechnungsstand“,
  „Jahressechstel Prognose“, „Zusätzlicher Prämien-Spielraum“, „Monatliche Gehaltsprognose“,
  „Lohnabrechnungen importieren“, Gruppen „Abrechnungsauswahl“ und „Steuerbeispiel Zusatzprämie“, die Labels
  `Steuerjahr`, `Dienstverhältnis`, `PDF auswählen` und `<Monat> Laufendes Brutto`. Geänderte Disclosure-Texte
  werden in den Tests bewusst angepasst.

### 2.5 M3 – Trade Republic in der Sparziel-Verteilung

- **Anzeige**: Im Schritt „Konten“ heißt die Quelle „Trade Republic · Notgroschen“ mit TR-Logo, Saldo, Zinssatz und
  dem Hinweis auf die Kontoregel. Statt gesperrt gibt es den Schalter **„Als Ausnahme einbeziehen“**, nur wenn
  Trade Republic vorhanden ist (TR-Saldo bekannt).
- **Mindestbestand**: Nach der Ausnahme fragt der Dialog „Mindestens behalten“, vorbelegt mit dem Notgroschen-Ziel
  (`settings.emergencyTarget`). Verplant wird nur, was darüber liegt.
- **Planung**: Trade Republic kommt **zuletzt** dran – nach dem Girokonto-Überschuss und den anderen Pockets. Damit
  die Zinsen möglichst lange laufen, liegt die Umbuchung standardmäßig im **letzten nötigen Monat** (Zieldatum bzw.
  bei „so schnell wie möglich“ im Erreichungsmonat). Andere Pockets bleiben wie bisher im ersten Monat.
- **Mini-Tabelle und Vorschau**: Die TR-Zeile zeigt Logo und Konto; Betrag überschreibbar wie bisher, **neu der
  Monat wählbar** (bei Umbuchungszeilen). Hinweis „entgangene Zinsen ca. … €“ aus dem aktuellen Zinssatz; Übersicht
  und Monatssäulen kennzeichnen die TR-Umbuchung. Auch als Startkapital-Quelle wählbar, wenn die Ausnahme aktiv ist.
- **Daten** (optional, keine Migration): `funding.exceptions?: { account, keep? }[]`. Gebucht wird wie bei anderen
  Pockets (Extra-Betrag des Ziels, Entnahme beim Notgroschen); die Monatsprojektion senkt den Notgroschen ab dem
  Umbuchungsmonat.
- **Unverändert**: Ziele ohne Ausnahme planen exakt wie heute (Vergleichstest); die Kontoregel selbst wird nicht
  geändert.

---

## 3. Abhängigkeiten

**Keine neuen npm-Pakete.** Benötigt werden nur Vorhandenes: Radix (Popover, Tooltip, Dialog), `motion`, das
Premium-Dialog-System, die Logo-Suche und die PNG-Umwandlung.

## 4. Meilensteine, Branches und Prüfungen

| Meilenstein | Branch (gestapelt auf `dialogs/m4-migration`) |
|---|---|
| Plan | `salary/m1-settings` |
| M1 Einstellungen + Bank-Logos | `salary/m1-settings` |
| M2 Gehalt & Steuern | `salary/m2-payroll` |
| M3 Trade Republic in der Sparziel-Verteilung | `salary/m3-goal-tr` |
| Zusammenfassung `docs/SALARY-SETTINGS-SUMMARY.md` | `salary/m3-goal-tr` |

Nach jedem Meilenstein: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`; ein Commit je Meilenstein.

## 5. Verifikation

- **Logik**: Bankverzeichnis (Aliase, BIC, Normalisierung), Logo-Auflösung inkl. Ablehnung fremder URLs,
  `payroll-overview` (Aufschlüsselung, fehlende Werte, Vormonat/Vorjahr, Jahressummen), Planer mit TR-Ausnahme
  (Reihenfolge, Mindestbestand, späte Umbuchung, Vergleich ohne Ausnahme).
- **Komponenten**: Kategorie-Navigation, Deep Links, Suche über Kategorien, Bankzeile mit Logo bzw. Monogramm,
  Bank-hinzufügen-Combobox mit Tastatur, Gehaltsseite mit und ohne Abrechnungen, Sparziel-Dialog mit TR-Ausnahme.
- **E2E** (neue `tests/salary-settings.spec.ts`): 375/768/1440 px hell und dunkel, kein horizontales Scrollen, axe
  ohne kritische/schwere Treffer, Deep Link `#bankverbindung`, Gehaltsseite mit Beispiel-Abrechnungen.
- Screenshots je Breite und Modus vorher/nachher (rein synthetische Daten), eine Prüfrunde plus eine Bestätigungsrunde;
  Design-Detektor auf allen geänderten UI-Dateien; Lighthouse-Stichprobe `/einstellungen` und `/gehalt-steuern`.

## 6. Risiken

| Risiko | Gegenmaßnahme |
|---|---|
| Tests erwarten alle Einstellungsbereiche auf einer Seite | Tests auf Kategorie-Navigation umstellen; Bereichs-IDs, Regionen und Beschriftungen bleiben |
| Logo-Abruf ohne Internet oder blockiert | Monogramm als Standard, Fehlschläge werden gemerkt, Seite wartet nie auf Logos |
| Fremde Logo-URLs als Angriffsweg | nur URLs aus der eigenen Bankliste und Verzeichnis-Domains, PNG-Neucodierung, Größenlimit |
| Unvollständige Abrechnungen verfälschen den Balken | Segmente nur aus belegten Werten, sonst „nicht auf der Abrechnung“ statt 0 |
| TR-Ausnahme leert den Notgroschen | Opt-in je Ziel, Mindestbestand, TR zuletzt, deutliche Anzeige im Plan |
| Umfang der Einstellungen-Komponenten | innere Steuerungen bleiben, neu sind Rahmen, Zeilen und Navigation |

## 7. Annahmen (bitte bestätigen oder korrigieren)

1. **Logo-Quelle**: Logos aus Enable Banking plus selbst gehostete Suche, lokal gespeichert, Monogramm als Fallback;
   kein Clearbit/Brandfetch, keine Logo-Dateien im Repository.
2. **Einstellungen**: fünf Kategorien wie in 2.2; ab 1024 px zweispaltig, darunter Übersicht mit Drill-in.
3. **Gehalt-Fokus**: Standardmonat ist die letzte Abrechnung des gewählten Jahres und Dienstverhältnisses.
4. **Vorjahresvergleich** erscheint erst, wenn Daten aus dem Vorjahr vorliegen (ab 2027).
5. **„Sonstige Abzüge“** nur, wenn Brutto, Netto, Lohnsteuer und SV belegt sind.
6. **Visualisierung** selbst gebaut (CSS/SVG), ohne Recharts auf dieser Seite.
7. **Trade Republic** nur als Ausnahme je Sparziel, Mindestbestand vorbelegt mit dem Notgroschen-Ziel, Umbuchung
   standardmäßig im letzten nötigen Monat.
8. **Importfeld** wandert in den Bereich „Abrechnungen“; ohne Abrechnungen ist es der Einstieg der Seite.
9. Ältere E2E-Specs, die auf Stände vor dem UI-Umbau zielen, werden wie bisher nicht repariert; die neuen Seiten
   deckt `tests/salary-settings.spec.ts` ab. Der veraltete README-Hinweis zu „Einstellungen → Trade Republic“ wird
   korrigiert.
