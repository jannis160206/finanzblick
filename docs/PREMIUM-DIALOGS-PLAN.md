# Premium-Dialoge – Plan

Ziel: ein einheitliches, animiertes Dialog-System (Desktop: zentriertes Modal, Mobile: Bottom Sheet,
lange Formulare automatisch Schritt für Schritt) und darauf aufbauend neue Dialoge für **Verträge** und
**Sparziele**; danach werden alle übrigen Eingabe-Dialoge umgestellt.

Status: **Plan – wartet auf Freigabe.** Es wird kein Code geschrieben, bevor der Plan bestätigt ist.

Die bestehende Gestaltung (Tokens in `docs/DESIGN-TOKENS.md`, Komponenten in `src/components/ui/`) bleibt die
gestalterische Grundlage; das neue System erweitert sie und ersetzt sie nicht.

---

## 1. Ist-Zustand

### 1.1 Technik

| Baustein | Stand |
|---|---|
| Dialog-Basis | `src/components/ui/dialog.tsx` auf Radix Dialog (`radix-ui`). Varianten `default` (max-w-xl), `confirmation` (max-w-md), `work` (max-w-4xl), `navigation` (Drawer links), `panel` (Drawer rechts, Assistent), `command` (globale Suche). Teile: `DialogHeader`, `DialogBody` (scrollt), `DialogForm`, `DialogFooter` (sticky, Buttons über `DialogFooterButtonContext` einheitlich). |
| Animation | CSS über `tw-animate-css`: 200 ms Fade + Zoom 95 %, Overlay-Fade, Drawer-Slide. Keine Federn, keine gestaffelten Inhalte, Schließen ist nur ein Fade. |
| Mobile | Dieselben zentrierten Modals (`w-[calc(100%-2rem)]`, `max-h-[calc(100dvh-2rem)]`). Kein Bottom Sheet, kein Wischen zum Schließen, Safe-Area nur im Footer der App-Shell. |
| Bewegung | `motion` 12 ist installiert; `MotionProvider` (`components/motion/`) lädt per `LazyMotion` nur `domAnimation` – für Ziehgesten (Drag) fehlt das Paket `domMax`. `MotionConfig reducedMotion="user"` bzw. `"always"` (App-Einstellung). |
| Sicherheitsmodus | `Dialog` blockiert Öffnen/Schließen im gesperrten Zustand, `DialogContent` rendert dann nichts (außer `navigation`/`command`); Overlay mit `data-financial-overlay`. |
| Formulare | Gemischt: einfacher `useState` (Sparziel, Vertrag, geplante Ausgaben, Jahressechstel), `react-hook-form` + `zod` (Buchungs-Zuordnung). Labels mal als `<label>`-Wrapper, mal `Label htmlFor`; Fehlermeldungen je Dialog selbst gebaut (`role="alert"`, `aria-invalid`), Fokus-Rückgabe je Dialog über `onCloseAutoFocus`. Kein gemeinsames Feld-, Betrags- oder Auswahlkarten-Element. |
| Breakpoints | `useCompactLayout()` = `max-width: 767px` (gleiche Grenze wie die untere Navigationsleiste). |
| Tokens | `ease-soft` / `ease-snappy`, `--duration-fast/base`, `shadow-overlay`, Radien bis `rounded-3xl`, `--safe-bottom`, Dark Mode über Klassen. |

### 1.2 Inventar: 31 Dialoge in 24 Dateien

| Gruppe | Dialoge (Datei) | Felder | Bemerkung |
|---|---|---|---|
| **Eingabe-Formulare** | Vertrag anlegen/bearbeiten, Vertrag kündigen (`contracts/contract-dialogs.tsx`) | 12 | längstes Formular, Kündigungsblock, Notiz |
| | Sparziel anlegen/bearbeiten, entfernen (`savings-goals.tsx`) | 3 | Name, Betrag, Bis-Datum – keine Planung |
| | Geplante Ausgaben (`planned-one-offs.tsx`) | 7 + Kalender | Raten, Gesamtbetrag, Pocket, geteilt |
| | Jahressechstel-Bruttowerte (`annual-sixth.tsx`) | 8 | Zahlen-lastig |
| | Planposition anlegen/löschen (`month-position-dialogs.tsx`) | 3 | Bezeichnung, Bereich, Planverknüpfung |
| | Zuordnung ändern, Sammel-Zuordnung (`transaction-assignment-dialogs.tsx`) | 3 | „Buchungsbearbeitung“, react-hook-form |
| | Tags (`transaction-tags.tsx`), Urlaubszeiträume (`holiday-ranges.tsx`), TR-Saldo (`tr-balance-dialog.tsx`), Bankverbindung (`bank-connections.tsx`), Belegaufteilung (`receipt-split-dialog.tsx`), Geteilte Kosten (`shared-costs.tsx`) | 1–5 | kurze Formulare |
| **Bestätigungen** | Löschen/Ignorieren (`transactions.tsx`), Händlersuche (`merchant-lookup-dialog.tsx`), Konto-Werkzeuge (`account-tools.tsx`), Buchungen leeren (`clear-bookings.tsx`), Lohnzettel (`payslip-import.tsx` ×2) | 0–1 | kurze Ja/Nein-Entscheidungen |
| **Arbeitsflächen** | Kontoauszug-Prüfung (`statement-import.tsx`), Import (`global-import.tsx`), Excel (`excel-actions.tsx`), Uploadstatus (`upload-status.tsx`) | Listen | große Prüflisten, kein Formular im engeren Sinn |
| **Navigation/Panels** | Seitenmenü (`app-shell.tsx`), Assistent (`assistant-launcher.tsx`), Suche (`shell/global-search.tsx`) | – | keine Eingabe-Dialoge |

„Notizen“ gibt es heute nur als Feld im Vertragsformular; einen eigenen Notiz-Dialog gibt es nicht.
Einstellungen sind Inline-Abschnitte; ihre Dialoge sind TR-Saldo, Urlaubszeiträume, Bankverbindung,
Konto-Werkzeuge, Excel und Buchungen leeren.

### 1.3 Lange oder komplexe Formulare

1. **Vertrag** (12 Felder, Kündigungs-Abschnitt, Notiz) – auf dem Handy über drei Bildschirmhöhen.
2. **Geplante Ausgaben** (7 Felder + Monatskalender).
3. **Jahressechstel** (8 Zahlenfelder).
4. **Sparziel** – heute kurz, soll aber Startkapital, Konten und Verteilung bekommen und wird damit das
   umfangreichste Formular.
5. **Kontoauszug-Prüfung** – lang, aber eine Prüfliste; sie bleibt eine Arbeitsfläche ohne Schritte.

### 1.4 Schwächen

- Keine Federn und keine Ausblend-Animation; Inhalte erscheinen auf einmal.
- Mobile: zentrierte Modals statt Bottom Sheets, kein Wischen, Daumenzone schlecht erreichbar.
- Keine Schritt-Dialoge; lange Formulare scrollen.
- Feld-, Fehler- und Fokuslogik wird in jedem Dialog neu gebaut; Betragseingaben uneinheitlich
  (`type="number"` vs. Freitext mit `parseMoneyText`).
- Verträge kennen nur monatlich/vierteljährlich/halbjährlich/jährlich; Buchungen lassen sich einem Vertrag
  nicht manuell zuordnen, Erkennungsregeln sind unsichtbar.
- Sparziele haben keine Planung (Startkapital, Quellkonten, Monatsraten); die Rate ergibt sich nur aus der
  automatischen Überschuss-Verteilung „Sparkonto → Ziele nach Termin → Urlaub“.

### 1.5 Testabhängigkeiten

- **28 von 68** Komponententest-Dateien und **~30 E2E-Specs** greifen auf Dialoge zu (Rollen, Namen,
  `data-variant`, Fokus-Rückgabe, „Dialog ist nach Schließen weg“).
- `tests/dialog-design.spec.ts` prüft u. a. den linken Drawer, begrenzte Arbeitsflächen mit sichtbaren
  Aktionen und Fokus-Rückgabe; `ui/dialog-privacy.test.tsx` das Verhalten im Sicherheitsmodus.
- Folgerung: Das neue System bleibt **API-kompatibel** zu `Dialog`/`DialogContent`/`DialogHeader`/…, und ohne
  Animation (reduzierte Bewegung, Testumgebung ohne `matchMedia`) wird sofort ein- und ausgehängt – genau wie
  heute. Bestehende Tests sollen dadurch weiterlaufen; nur Tests der bewusst neu gestalteten Formulare
  (Sparziel, Vertrag) werden angepasst.

---

## 2. Soll-Zustand

### 2.1 Architektur

Neuer Ordner `src/components/ui/premium-dialog/`:

| Modul | Aufgabe |
|---|---|
| `premium-dialog.tsx` | `PremiumDialog` (Root mit Sicherheitsmodus wie bisher), `PremiumDialogContent` (entscheidet Modal vs. Sheet), `PremiumDialogHeader/Body/Footer`, `PremiumDialogForm` |
| `animated-sheet.tsx` | Bottom Sheet: Snap-Points, Ziehen am Griff und Kopfbereich, Wischen zum Schließen, Safe-Area, Tastatur-Vermeidung (`visualViewport`) |
| `dialog-steps.tsx` | `DialogSteps` / `DialogStep`: Schrittzustand, Validierung je Schritt, Weiter/Zurück, Fortschritt, Auto-Modus |
| `step-indicator.tsx` | Fortschrittsbalken (Mobile) bzw. benannte Schritt-Punkte (Desktop), klickbar für erledigte Schritte |
| `fields.tsx` | `Field` (Label, Hinweis, Fehler, ARIA-Verknüpfung, Fokus-Animation), `MoneyField` (de-AT, `parseMoneyText`), `ChoiceCards` (Auswahlkarten als Radiogruppe), `ToggleRow`, `SearchableCheckList` |
| `dialog-states.tsx` | einheitliche Leerzustände und Lade-Skelette im Dialog |
| `motion.ts` | Federn, Dauern, Varianten an einer Stelle; Erkennung reduzierter Bewegung |

Die bestehenden Exporte in `ui/dialog.tsx` bleiben erhalten. In M4 werden die Varianten `default`,
`confirmation` und `work` intern auf das neue System umgestellt, so dass alle Aufrufer ohne Umbau profitieren;
`navigation`, `panel` und `command` behalten ihre Form (Drawer bzw. Befehlspalette) und bekommen nur dieselbe
Overlay- und Feder-Abstimmung.

Skizze der API:

```tsx
<PremiumDialog open={open} onOpenChange={setOpen}>
  <PremiumDialogContent size="lg" sheet={{ snapPoints: [0.6, 0.94] }} preview={<ContractPreview draft={draft} />}>
    <PremiumDialogHeader title="Vertrag hinzufügen" description="In fünf kurzen Schritten." />
    <DialogSteps mode="auto" onComplete={save}>
      <DialogStep id="basics" title="Grunddaten" validate={validateBasics}>…</DialogStep>
      <DialogStep id="interval" title="Rhythmus">…</DialogStep>
      …
    </DialogSteps>
  </PremiumDialogContent>
</PremiumDialog>
```

### 2.2 Darstellung und Bewegung

| | Desktop / Tablet (≥ 768 px) | Mobile (< 768 px) |
|---|---|---|
| Form | zentriertes Modal, Größen `sm` 28 rem, `md` 36 rem, `lg` 44 rem, `xl` 60 rem; `xl`-Schrittdialoge ab 1024 px zweispaltig mit Live-Vorschau rechts | Bottom Sheet volle Breite, oben `rounded-t-3xl`, Griff, Safe-Area unten |
| Öffnen | Overlay Opacity 0 → 1 (Blur als statischer `backdrop-filter`); Inhalt Opacity + Scale 0,96 → 1 + y 8 px → 0, Feder **stiffness 300, damping 28** | y 100 % → Snap-Point, Feder stiffness 300, damping 30 |
| Schließen | `AnimatePresence`: Scale 0,98 + Fade, 150 ms (schneller als Öffnen) | gleitet nach unten heraus |
| Inhalt | Header, Felder und Footer blenden gestaffelt ein (35 ms Abstand, 6 px Anstieg, höchstens 6 Elemente, nur beim ersten Öffnen) | wie Desktop |
| Schritte | Wechsel mit Fade + x ± 24 px, richtungsabhängig; feste Dialoghöhe je Schrittdialog (größter Schritt bzw. Snap-Point), damit keine Layout-Animation nötig ist | wie Desktop; Fortschrittsbalken statt Schrittliste |
| Gesten | – | Ziehen am Griff/Kopf: einrasten am nächsten Snap-Point; Schließen ab 35 % Höhe oder > 600 px/s; Inhalt scrollt normal, Ziehen startet nur oben bzw. am Griff |

- **Nur GPU-freundliche Eigenschaften** (`transform`, `opacity`; `filter` nur für den Fokus-Glow der Felder).
  Keine Höhen- oder Layout-Animationen.
- **Reduzierte Bewegung** (Systemeinstellung **und** App-Einstellung): nur Opacity in 120 ms, keine Staffelung,
  kein Scale/Slide; Sheet rastet ohne Feder ein. Ohne `matchMedia` (Testumgebung) keine Animation.
- **Performance**: `domMax` (für Ziehen) wird erst beim ersten Öffnen eines Sheets nachgeladen; die großen
  Schrittdialoge (Vertrag, Sparziel) werden per `next/dynamic` erst beim Öffnen geladen. Ziel: kein
  messbarer Rückschritt der M3-Lighthouse-Werte (Toleranz ±3 Punkte).

### 2.3 Barrierefreiheit

- Radix liefert Fokusfalle, Escape, Fokus-Rückgabe, `aria-modal` und Scroll-Sperre; bestehende
  `onCloseAutoFocus`-Logik bleibt nutzbar.
- Sheet-Griff ist ein Button („Größe ändern“), Pfeiltasten wechseln den Snap-Point; Wischen ist nie der
  einzige Weg (Schließen-Button bleibt).
- Schritte: `nav aria-label="Schritte"`, `aria-current="step"`, Live-Region „Schritt 2 von 5: Rhythmus“;
  Fortschrittsbalken mit `role="progressbar"`. Enter = Weiter (nicht in Textfeldern), letzter Schritt speichert.
- Fehler: `aria-invalid`, `aria-describedby`, `role="alert"`, Fokus springt zum ersten fehlerhaften Feld;
  Fehlertexte nennen Problem und Lösung.
- Touch-Ziele ≥ 44 px, sichtbare Fokusringe, Kontrast ≥ 4,5:1 in Hell und Dunkel.

### 2.4 Automatische Schritte

`DialogSteps mode="auto" | "always" | "never"`:

- **auto**: Der Dialog misst beim Öffnen die Gesamthöhe aller Abschnitte (`ResizeObserver`). Passt sie in die
  verfügbare Höhe (Desktop 80 % der Fensterhöhe, Sheet oberster Snap-Point), werden alle Abschnitte als ein
  Formular mit Zwischenüberschriften gezeigt; sonst Schritt für Schritt. Der Modus wechselt während eines
  offenen Dialogs nicht mehr (kein Springen beim Tippen).
- Auf Mobile werden Dialoge mit mehr als einem Abschnitt grundsätzlich schrittweise gezeigt.
- Validierung je Schritt vor „Weiter“; erledigte Schritte bleiben anklickbar; beim Bearbeiten eines
  bestehenden Eintrags sind alle Schritte frei anwählbar und „Speichern“ ist sofort möglich.
- **Ungespeicherte Eingaben** in Schrittdialogen: Escape, Klick daneben und Wischen fragen inline
  („Entwurf verwerfen?“) statt alles zu verlieren. Einfache Dialoge behalten das heutige Verhalten
  (Abbrechen/Escape verwirft sofort), damit dokumentiertes Verhalten und Tests stabil bleiben.

### 2.5 M2 – Vertrag als Schrittdialog

Ersetzt `ContractEditDialog` (Anlegen und Bearbeiten). Desktop zweispaltig mit dauerhaft sichtbarer
Live-Vorschau, Mobile fünf Schritte mit Vorschau als letztem Schritt.

| Schritt | Inhalt |
|---|---|
| 1 Grunddaten | Name, Betrag (`MoneyField`), Kategorie, Kündigungsfrist (Zahl + Einheit) mit Hinweis auf übliche Fristen; aufklappbar „Mehr“: Mindestlaufzeit, automatische Verlängerung, Notiz |
| 2 Rhythmus | Auswahlkarten: wöchentlich, **alle 2 Wochen**, monatlich, alle 3 Monate, halbjährlich, jährlich – jede Karte zeigt den Monatsbetrag („≈ 28,15 € im Monat“); nächste Abbuchung (Datumsfeld, vorgeschlagen aus den Buchungen) |
| 3 Buchungen | Durchsuchbare Liste der Abbuchungen (24 Monate) mit Checkbox, Händler-Logo (`MerchantMark`), Datum und Betrag; vorsortiert nach Ähnlichkeit zu Name und Betrag. Ausgewählte oben gruppiert als Zeitstrahl mit Ø-Betrag und erkanntem Abstand; Vorschlag „Sieht nach alle 2 Wochen aus – übernehmen?“ |
| 4 Erkennung | Transparente, änderbare Regeln: „Text enthält“, Betrag von–bis (aus der Auswahl ± Toleranz), Konto. Live-Zähler „passt auf 9 Buchungen, davon 2 noch nicht ausgewählt“ mit Liste |
| 5 Vorschau | „So würde der Vertrag aussehen“: Karte wie im Vertragsordner (Logo, Name, Betrag, Rhythmus, Monats-/Jahreskosten, nächster Termin, Kündigungsdeadline, Anzahl zugeordneter Buchungen), danach Speichern |

**Datenmodell** (optional im JSON-Stand, keine SQL-Migration):
- `contractIntervals` um `weekly` und `biweekly` erweitern; Schrittweite wird in `src/lib/contracts.ts` von
  Monaten auf Tage verallgemeinert (Monatsäquivalent 52/12 bzw. 26/12). Die automatische Erkennung lernt
  zusätzlich „alle 2 Wochen“ (Abstand 12–16 Tage, mindestens 4 Abbuchungen); „wöchentlich“ nur manuell oder
  über Erkennungsregeln (sonst würden Wocheneinkäufe als Verträge erkannt).
- `ContractOverride` erhält `bookingIds?` (manuell zugeordnet), `excludedBookingIds?` und
  `match?: { text?, amountMin?, amountMax?, account? }`.
- Regeln und Auswahl ergeben die Abbuchungen eines Vertrags; künftige passende Buchungen werden automatisch
  zugeordnet. Eine automatisch erkannte Serie, deren Buchungen größtenteils zu einem manuellen Vertrag
  gehören, wird ausgeblendet – damit zählen Vertragsordner, Prognose und Hinweise nichts doppelt.

### 2.6 M3 – Sparziel als Schrittdialog mit intelligenter Verteilung

Ersetzt den Sparziel-Dialog in `savings-goals.tsx`.

| Schritt | Inhalt |
|---|---|
| 1 Ziel | Name, Zielbetrag, Zieldatum **oder** „So schnell wie möglich“; Ziel-Pocket (Standard: wie der Name, wie heute) |
| 2 Startkapital (optional) | Betrag + Herkunft: „liegt schon auf dem Ziel-Pocket“ (→ `openingBalance`, wie heute) oder „von Konto X übertragen“ (→ geplante Überweisung im aktuellen Monat); Konten mit verfügbarem Betrag |
| 3 Konten | Mehrfachauswahl der Quellen: Girokonto (freier Monatsüberschuss laut Plan/Prognose) und Konten/Pockets mit Guthaben (`balances()`), jeweils mit verfügbarem Betrag nach Puffer und Reservierungen anderer Ziele; Kontoregeln („Notgroschen nie“) werden beachtet |
| 4 Verteilung | Schalter **„Automatisch planen“**. Mini-Tabelle *Monat · Konto · geplanter Betrag · anpassen* mit Betrag überschreiben (wird fixiert), Monat oder Konto ausschließen, Zeile zurücksetzen; Summe, „Ziel erreicht am …“ bzw. „Es fehlen 240 € – Datum verschieben oder Konto ergänzen?“ |
| 5 Übersicht | Fortschrittsbalken (Startkapital + geplante Raten bis zum Ziel), kompakte Monatsbalken der Einzahlungen (CSS, keine Chart-Bibliothek), Speichern |

**Planungslogik** (neues Modul `src/lib/goal-planner.ts`, deterministisch, getestet):
1. Kapazität je Monat aus dem Girokonto: geplanter Überschuss aus `dashboard.timeline` nach Fixkosten,
   Verträgen, geplanten Ausgaben und den Raten **früher fälliger** Ziele; im aktuellen Monat höchstens das
   frei Verfügbare aus `monthEndForecast`; abzüglich Puffer.
2. Kapazität der Guthaben-Konten: verfügbarer Betrag (einmalig, nicht monatlich).
3. Verteilung: Restbetrag möglichst **gleichmäßig** über die Monate (Water-Filling: gleiche Rate, wo die
   Kapazität fehlt, gehen die Beträge in Monate mit mehr Spielraum, z. B. Sonderzahlungsmonate). Reicht der
   Überschuss nicht, werden Guthaben-Konten herangezogen – erst das mit dem größten freien Betrag, Notgroschen
   zuletzt bzw. gar nicht laut Kontoregeln. „So schnell wie möglich“ nutzt die volle Kapazität und berechnet
   das Datum.
4. Fixierte Zeilen und Ausschlüsse bleiben unangetastet; nur die übrigen Zeilen werden neu verteilt.
5. Planungshorizont = Planungszeitraum der App (bis Dezember des Folgejahres); liegt das Ziel dahinter,
   wird die letzte Rate als laufende Monatsrate weitergeführt und so angezeigt.

**Datenmodell** (optional, keine SQL-Migration): `savingsGoal.funding` erhält
`plan?: { month, account, amount, locked? }[]`, `excluded?: { months?, accounts? }` und `auto?: boolean`;
`savingsGoal` erhält `asap?: boolean` und `start?: { amount, account, date }`.

**Integration**: `allocateGoals` (`src/lib/goals.ts`) und die Monatsrechnung verwenden für Ziele mit Plan die
geplanten Beträge: Girokonto-Zeilen als Rate aus dem Überschuss, Konto-Zeilen als Übertrag aus dem jeweiligen
Konto (Ziel steigt, Quellkonto sinkt in der Projektion). Ziele **ohne** Plan werden exakt wie heute berechnet –
abgesichert durch einen Vergleichstest, der `calculateDashboard` für bestehende Stände vor und nach der
Änderung vergleicht. Überwiesen wird nichts automatisch; geplante Beträge erscheinen wie heute als
Überweisungs-Aufgaben („Sparraten“), die beim Import abgehakt werden.

### 2.7 M4 – Umstellung aller Eingabe-Dialoge

| Dialog | Ziel |
|---|---|
| Geplante Ausgaben | Premium-Dialog, `mode="auto"`: Schritte „Was & wann“ (Name, Datum/Kalender) und „Betrag & Raten“ (Betrag, Raten, Gesamt, Pocket, geteilt) |
| Jahressechstel | `mode="auto"`: „Arbeitgeber & Monat“, „Bruttowerte“ |
| Zuordnung ändern, Sammel-Zuordnung, Tags, Planposition, Urlaubszeiträume, TR-Saldo, Bankverbindung, Belegaufteilung, Geteilte Kosten | Premium-Dialog (Modal/Sheet), gemeinsame `Field`/`MoneyField`, einheitliche Fehler und Fokus |
| Bestätigungen (Löschen, Kündigen, Leeren, Lohnzettel, Händlersuche, Konto-Werkzeuge, Sparziel entfernen) | Premium-Dialog `size="sm"`, auf Mobile kompaktes Sheet |
| Arbeitsflächen (Kontoauszug-Prüfung, Import, Excel, Uploadstatus) | Premium-Dialog `size="xl"`; auf Mobile Sheet mit oberem Snap-Point, keine Schritte |
| Seitenmenü, Assistent, Suche | bleiben Drawer bzw. Palette; gleiche Overlay-/Federwerte |

Dazu: einheitliche Button-Anordnung im Footer (Primär rechts bzw. unten voll breit auf Mobile), Fokus-Animation
der Eingabefelder, gleiche Fehlerdarstellung; README-Abschnitt zu Dialogen aktualisiert.

---

## 3. Abhängigkeiten

**Keine neuen npm-Pakete.** `motion` (inkl. `domMax` für Ziehgesten), `radix-ui`/`@radix-ui/react-dialog`,
`react-hook-form`, `@hookform/resolvers` und `zod` sind bereits installiert. Eine separate Drawer-Bibliothek
(z. B. vaul) ist nicht nötig, weil Sheet und Gesten mit `motion` umgesetzt werden.

## 4. Meilensteine, Branches und Prüfungen

| Meilenstein | Branch (gestapelt auf `features/m4-copilot`) |
|---|---|
| Plan | `dialogs/m1-foundation` |
| M1 Premium-Dialog, Sheet, Schritte, Felder | `dialogs/m1-foundation` |
| M2 Vertrags-Schrittdialog | `dialogs/m2-contract` |
| M3 Sparziel-Schrittdialog mit Verteilung | `dialogs/m3-goal` |
| M4 Umstellung aller Eingabe-Dialoge | `dialogs/m4-migration` |

Nach jedem Meilenstein: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`; ein Commit pro
Meilenstein; am Ende `docs/PREMIUM-DIALOGS-SUMMARY.md`.

## 5. Verifikation

- **Komponententests** (jsdom): Fokusfalle, Escape, Fokus-Rückgabe, Sicherheitsmodus, Schritt-Navigation und
  -Validierung, Auto-Modus (gemessene Höhen simuliert), reduzierte Bewegung, Sheet-Griff per Tastatur,
  Entwurf-verwerfen-Abfrage; Vertrags- und Sparziel-Dialog Ende-zu-Ende im Komponententest.
- **Logiktests**: neue Intervalle, Regeln und Auswahl in `contracts.ts` (inkl. keine Doppelzählung in Prognose
  und Hinweisen), Planungsalgorithmus (gleichmäßig, Kapazitätsgrenzen, Konten, fixierte Zeilen, Ausschlüsse,
  „so schnell wie möglich“, Horizont), Vergleichstest „ohne Plan unverändert“.
- **E2E** (neue `tests/premium-dialogs.spec.ts`): 375/768/1440 px ohne horizontales Scrollen, Sheet ziehen
  und wischen auf 375 px, Modal auf 1440 px, Tastaturbedienung, axe-Prüfung geöffneter Dialoge; bestehende
  Dialog-Specs laufen weiter (angepasst nur, wo Formulare bewusst neu sind).
- Screenshots Hell/Dunkel je Breite; Lighthouse-Stichprobe `/` und `/vertraege` gegen M3.

## 6. Risiken

| Risiko | Gegenmaßnahme |
|---|---|
| Viele Tests hängen an Dialogen | API-kompatibel bleiben; ohne Animation sofortiges Ein-/Aushängen; Umstellung der Basis-Varianten erst in M4 |
| Exit-Animation hält Dialoge länger im DOM | kurze Exit-Dauer (150 ms), in Tests und bei reduzierter Bewegung keine |
| Ziehen kollidiert mit Scrollen im Sheet | Ziehen nur am Griff/Kopf oder wenn der Inhalt oben steht |
| Bildschirmtastatur verdeckt Felder im Sheet | `visualViewport`-Anpassung, fokussiertes Feld wird sichtbar gescrollt |
| Sparziel-Plan verändert die Monatsrechnung | strikt optional, Vergleichstest für Stände ohne Plan, Vorschau vor dem Speichern |
| Neue Intervalle betreffen Erkennung und Prognose | Tests für alle Intervalle; wöchentlich nicht automatisch |
| Bundle-Größe | `domMax` und große Dialoge erst bei Bedarf laden; Lighthouse-Stichprobe |

## 7. Annahmen (bitte bestätigen oder korrigieren)

1. **Bottom Sheet unter 768 px** (gleiche Grenze wie die untere Navigationsleiste); ab 768 px Modal.
2. **Seitenmenü, Assistent und Suche** bleiben Drawer bzw. Befehlspalette (keine Eingabe-Dialoge), bekommen
   aber dieselben Overlay- und Federwerte.
3. **Neue Vertrags-Intervalle**: wöchentlich und alle 2 Wochen; automatisch erkannt wird zusätzlich nur
   „alle 2 Wochen“.
4. **Sparziel-Plan ist verbindlich für die Monatsplanung**: Wer „Automatisch planen“ speichert, bekommt
   genau diese Raten im Monatsplan und als Überweisungs-Aufgaben; ohne Plan bleibt alles wie heute.
   Ausgeführt wird nichts automatisch.
5. **„So schnell wie möglich“** setzt das Zieldatum auf den berechneten Erreichungsmonat und aktualisiert es,
   wenn sich der Plan ändert.
6. **Entwurfsschutz** nur bei Schrittdialogen; einfache Dialoge verwerfen weiterhin sofort.
7. **Notizen**: kein eigener Notiz-Dialog; die Notiz bleibt Teil des Vertrags (Schritt 1, „Mehr“).
8. **Planungshorizont** des Sparziel-Plans = Planungszeitraum der App (bis Dezember des Folgejahres), danach
   laufende Monatsrate.
