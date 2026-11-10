# Premium-Dialoge – Zusammenfassung

Umsetzung von [`PREMIUM-DIALOGS-PLAN.md`](PREMIUM-DIALOGS-PLAN.md). Der Plan wurde ohne ausdrückliche Freigabe
umgesetzt (der Nutzer war nicht erreichbar und bat um selbstständiges Arbeiten); dabei galten die empfohlene
Variante und alle acht Annahmen aus Abschnitt 7 des Plans.

## Commits und Branches (gestapelt)

| Branch | Commit | Inhalt |
|---|---|---|
| `dialogs/m1-foundation` | `e27de53` | Plan |
| `dialogs/m1-foundation` | `8a6e360` | M1 Premium-Dialog, Bottom Sheet, Schritte, Felder |
| `dialogs/m2-contract` | `21dfd2d` | M2 Vertrags-Schrittdialog mit Buchungsauswahl und Regeln |
| `dialogs/m3-goal` | `ab62fa9` | M3 Sparziel-Schrittdialog mit intelligenter Verteilung |
| `dialogs/m4-migration` | `5c1cfd1` | M4 Umstellung aller Eingabe-Dialoge, E2E-Spec |
| `dialogs/m4-migration` | (dieser Commit) | Zusammenfassung |

Der GitHub-Remote war wie in den vorigen Runden nicht erreichbar („Repository not found“); es wurde nichts
gepusht und es gibt keine Pull Requests. Jeder Branch baut auf dem vorigen auf und kann als eigener PR geöffnet
werden.

## M1 – Dialog-System (`src/components/ui/premium-dialog/`)

- **`PremiumDialogContent`**: ab 768 px zentriertes Modal (Feder 300/28, Skalierung + leichtes Gleiten),
  darunter **Bottom Sheet** mit Griff, Rastpunkten (Anteil der Bildschirmhöhe), Ziehen am Griff/Kopf,
  Wischen zum Schließen (Wurfgeschwindigkeit oder unter 60 % der kleinsten Höhe), Gummiband nach oben,
  Safe-Area-Abstand und Ausweichen vor der Bildschirmtastatur (`visualViewport`). Overlay mit Unschärfe und
  Überblendung, Ausblenden über `AnimatePresence`, Innenelemente gestaffelt.
- **Barrierefreiheit**: Radix-Fokusfalle, Escape, Scroll-Sperre; Fokus kehrt zum auslösenden Element zurück
  (auch ohne `DialogTrigger`); Griff per Tastatur bedienbar („Höhe anpassen“, Pfeiltasten).
- **Bewegung**: `full` / `reduced` (System oder App-Einstellung → nur kurze Überblendungen) / `none`
  (Tests). Nur `transform`, `opacity` und `filter` werden animiert.
- **`DialogSteps`**: `mode="auto"` wechselt auf dem Handy immer, am Desktop bei überlaufendem Inhalt zu
  Schritten; Fortschrittsbalken mit Schrittnamen, Weiter/Zurück, Validierung je Schritt mit Fokus auf das
  erste fehlerhafte Feld, Bearbeitungsmodus mit freier Navigation und Speichern auf jedem Schritt,
  Live-Region für Screenreader. Neu in M4: `submitDisabled` sperrt nur das finale Speichern.
- **Felder**: `Field` (Label, Hinweis, animierter Fehler, `aria-describedby`), `MoneyField` (de-AT-Eingabe,
  formatiert beim Verlassen), `ChoiceCards` (Radiogruppe mit Pfeiltasten), `ToggleRow` (Schalter),
  `DialogSkeleton`, `DialogEmpty`.
- **Entwurfsschutz** in Schritt-Dialogen: Escape, Klick daneben und Wischen fragen „Ungespeicherte Eingaben
  verwerfen?“; „Abbrechen“ und das X verwerfen bewusst sofort.

## M2 – Vertrag als Schrittdialog (`contract-wizard.tsx`)

Fünf Schritte mit Live-Vorschau (ab 1024 px als Spalte daneben, sonst im letzten Schritt):

1. **Grunddaten**: Name, Betrag je Abbuchung (mit Monats-/Jahreskosten), Kategorie, Kündigungsfrist mit
   Einheit und typischer Frist je Vertragsart; „Laufzeit & Notiz“ aufklappbar (Mindestlaufzeit,
   automatische Verlängerung, Notiz).
2. **Rhythmus**: Auswahlkarten wöchentlich, alle 2 Wochen, monatlich, vierteljährlich, halbjährlich,
   jährlich (jeweils mit Jahreskosten); nächste Abbuchung mit Vorschlag aus den Buchungen.
3. **Buchungen**: durchsuchbare Liste (Händler, Text, Betrag) mit Händler-Logos bzw. Initialen, Datum,
   Konto, Betrag und Hinweis „Gehört zu …“; die Gruppierung bleibt beim Anhaken stabil. Auswahl-Zusammenfassung
   mit Durchschnitt, erkanntem Rhythmus, Zeitraum, Zeitleiste und Vorschlägen (Rhythmus, Betrag, nächster
   Termin, „Alles übernehmen“).
4. **Erkennung**: „Neue Abbuchungen automatisch zuordnen“ mit „Buchungstext enthält“, Betragsspanne und
   Konto; Trefferzahl live, „Alle übernehmen“, Hinweis auf ausgewählte Buchungen außerhalb der Regel.
5. **Vorschau**: so erscheint der Vertrag in der Liste, nächste drei Abbuchungen, Prüfpunkte.

Logik (`src/lib/contracts.ts`): Intervalle wöchentlich/alle 2 Wochen (`perYear`, `stepDate`), automatische
Erkennung zusätzlich „alle 2 Wochen“ ab vier Abbuchungen (wöchentlich nie automatisch), Regel-Abgleich
(`contractRuleMatches`), Regelvorschlag, Rhythmus aus Datumsabständen, ausgewählte und per Regel gefundene
Buchungen bilden die Abbuchungen eines Vertrags, abgewählte bleiben draußen; eine automatisch erkannte Serie,
deren Buchungen zur Hälfte ein eigener Vertrag übernimmt, verschwindet als Doppel.

## M3 – Sparziel als Schrittdialog (`savings-goal-wizard.tsx`, `src/lib/goal-planner.ts`)

1. **Ziel**: Name, Zielbetrag, Zieldatum oder „So schnell wie möglich“.
2. **Startkapital** (optional): liegt schon auf dem Pocket, oder Umbuchung vom Girokonto bzw. einem anderen
   Pocket (jeweils mit freiem Betrag; ohne freien Betrag nicht wählbar).
3. **Konten**: Monatsüberschuss des Girokontos (Ø frei pro Monat) und Pockets mit verfügbarem Betrag;
   Kontoregeln („Notgroschen nur für Notfälle“, Budget- und Ziel-Pockets) werden angezeigt und beachtet.
4. **Verteilung**: Schalter „Automatisch planen“ und Mini-Tabelle *Monat · Konto · Betrag · anpassen*.
   Betrag überschreiben fixiert die Zeile (der Rest wird neu verteilt), Monate ausschließen und wieder
   aufnehmen, Zeilen zurücksetzen; Status „Ziel erreicht im …“ bzw. „Es fehlen … – Datum verschieben“ mit
   Ein-Klick-Vorschlag; laufende Rate nach dem Planungszeitraum. Ohne automatische Planung: feste
   Monatsrate oder wie bisher nach Termin aus dem Überschuss.
5. **Übersicht**: Fortschrittsbalken (vorhanden, Umbuchungen, Monatsraten, danach), Monatsbalken der
   geplanten Einzahlungen über den ganzen Zeitraum, Zieldatum, „Laut Plan erreicht“, Ø Monatsrate.

Planung: Spielraum je Monat = freier Überschuss nach Fixkosten, Budgets, geplanten Ausgaben, anderen Zielen
und dem Sparkonto-Sockel (aktueller Monat zusätzlich höchstens das frei Verfügbare der Monatsend-Prognose).
Mit Zieldatum wird so gleichmäßig wie möglich verteilt (Water-Filling auf ganze Euro, Cent exakt),
Pockets füllen nur eine verbleibende Lücke als einmalige Umbuchung; „So schnell wie möglich“ nutzt zuerst
die gewählten Pockets, dann den vollen Überschuss.

Datenmodell (optional, keine Migration): `funding.plan`, `funding.window`, `funding.excluded`,
`funding.auto`, `asap`, `start`. `allocateGoals` nutzt im Planfenster die geplanten Girokonto-Raten;
Umbuchungen aus Pockets laufen wie beim Assistenten als Extra-Betrag des Ziels plus Entnahme im Monatsplan.
**Ziele ohne Plan werden exakt wie bisher berechnet** – geprüft gegen eine wörtliche Kopie der alten
Funktion in 400 zufälligen Fällen.

## M4 – Umstellung aller Eingabe-Dialoge

- `DialogContent` mit `default`, `confirmation` und `work` rendert jetzt die Premium-Oberfläche
  (API-kompatibel: `data-variant`, Kopf/Inhalt/Fuß, Schließen-Knopf, Fokus-Callbacks). Damit nutzen alle
  rund 25 Eingabe-, Bestätigungs- und Arbeitsdialoge Modal bzw. Bottom Sheet, Federn, Fokusführung und
  Scroll-Sperre. Seitenmenü, Assistent und Suche bleiben Schubladen bzw. Befehlspalette.
- Geschlossene Dialoge abonnieren keine Media-Queries mehr (Layout und Bewegungsmodus erst beim Öffnen).
- Schritt-Dialoge zusätzlich für **Geplante Ausgaben** („Was & wann“, „Betrag & Raten“) und
  **Jahressechstel** („Abrechnung“, „Bruttowerte“); Beträge als `MoneyField`, Beschriftung/Fehler als
  `Field`. Tag- und Kündigungsdialog nutzen `Field` (Innenabstand des Tag-Dialogs korrigiert).
- Einheitliche Buttons im Fuß (Primär rechts bzw. auf dem Handy volle Breite), Fokus-Animation und
  Fehlerdarstellung der Eingabefelder über die bestehenden Tokens.

## Prüfungen

| Prüfung | Ergebnis |
|---|---|
| `npm run typecheck`, `npm run lint`, `npm run build` | grün nach jedem Meilenstein |
| `npm test` | 4.817 bestanden (5 erwartete Fehlschläge, 3 übersprungen, wie zuvor) |
| Neue Unit-/Komponententests | Dialog-System (12), Verträge (+7 Logik, 3 Dialog), Planer und Zuteilung (10), Sparziel-Dialog (3) |
| `tests/premium-dialogs.spec.ts` | 8/8 – Vertrag und Sparziel bei 375/768/1440 px (Sheet bzw. Modal, kein horizontales Scrollen, axe ohne kritische/schwere Treffer), Wischen und Escape, einfache Dialoge |
| `tests/responsive.spec.ts`, `tests/a11y.spec.ts` | grün mit den neuen Dialogen |
| Design-Detektor (impeccable) auf allen geänderten UI-Dateien | keine Befunde |
| Screenshots hell/dunkel bei 375 und 1440 px | geprüft, Befunde behoben (u. a. Label-Überlappung, Kontrast, Liste springt beim Anhaken) |

Lighthouse (Performance, 3 Läufe, Median; gleicher Aufbau wie in `PERFORMANCE.md`, Vergleich mit dem Stand
direkt vor dieser Arbeit, `e27de53`):

| Seite | vorher Mobil | nachher Mobil | vorher Desktop | nachher Desktop |
|---|---|---|---|---|
| `/` | 69 | 68 | 95 | 98 |
| `/vertraege` | 76 | 75 | 96 | 96 |

Unterschiede liegen im Messrauschen; die großen Dialoge werden erst beim Öffnen geladen.

## Abweichungen vom Plan

- Das Ziehen des Bottom Sheets nutzt eigene Pointer-Events und `animate()` auf einem Motion-Wert statt
  `domMax`-Gesten; das spart das größere Motion-Paket.
- „Automatisch planen“ ist für neue Sparziele voreingestellt (Schlüssel-Feature); bestehende Ziele ohne Plan
  bleiben beim Bearbeiten ohne Plan, solange der Schalter nicht aktiviert wird.
- Startkapital per Umbuchung aus einem anderen Pocket gibt es nur mit automatischer Planung (es wird als
  fixierte Planzeile gespeichert); ohne Planung weist der Dialog darauf hin.
- Gefundener Kontrastfehler im Dunkelmodus (Hinweisbanner der Verteilung) wurde durch die axe-Prüfung entdeckt
  und behoben.

## Offene Punkte

- **Ältere E2E-Specs** (`savings-goals`, `dialog-design`, `settings-design`, `ux-cut` u. a.) zielen noch auf
  Stände vor dem UI-Umbau (z. B. Sparziele unter `/einstellungen`, frühere Menüs) und schlugen bereits vor
  dieser Arbeit fehl. Beschriftungen und Ablauf des Sparziel-Dialogs wurden darin angepasst, die Routen nicht.
  Die neuen Dialoge sind durch `tests/premium-dialogs.spec.ts` abgedeckt.
- Weitere Formulare (Zuordnung ändern, Sammel-Zuordnung, Belegaufteilung, geteilte Kosten, Bankverbindung,
  Urlaubszeiträume, TR-Saldo, Planposition) laufen auf der neuen Oberfläche, behalten aber ihre bisherige
  Feldvalidierung; eine Umstellung auf `Field`/`MoneyField` je Feld steht noch aus.
- Ändert der Assistent die Rate eines Ziels mit gespeichertem Plan, wirkt das nur außerhalb des Planfensters.
- „So schnell wie möglich“ berechnet das Datum beim Speichern; es wird nicht automatisch nachgeführt, wenn
  sich später die Einnahmen ändern (beim nächsten Bearbeiten wird neu geplant).
- Als Umbuchungsquelle stehen die vier Kern-Pockets (Notgroschen, Urlaub, Sparkonto, Motorrad) zur Verfügung;
  weitere Revolut-Pockets werden in der Projektion nicht als Quelle geführt.
- Wöchentliche Verträge werden nicht automatisch erkannt (bewusst, sonst würde der Wocheneinkauf erkannt).
- Der Desktop-CLS von 0,09 auf `/` (Block „Geplant“) bestand schon vor dieser Arbeit.
- Kein Push und keine Pull Requests, weil der Remote nicht erreichbar ist.
