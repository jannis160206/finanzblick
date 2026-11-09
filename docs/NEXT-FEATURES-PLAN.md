# Next Features – Plan (Verträge, Prognose, Mobile-Performance, Finanz-Copilot)

Status: **Entwurf, wartet auf Freigabe.** Vor der Freigabe wird kein Code geändert.

Basis: Branch `rebuild/m6-polish` (Stand nach dem UI-Umbau, siehe `docs/REBUILD-SUMMARY.md`).
Neue Arbeit erfolgt auf gestapelten Branches `features/m1-contracts` → `features/m2-forecast` →
`features/m3-performance` → `features/m4-copilot`, je Meilenstein ein Commit.

---

## 1. Ist-Zustand

### 1.1 Wiederkehrende Buchungen, Fixkosten, Händler

| Baustein | Datei | Was er heute tut |
|---|---|---|
| Händler-Identität | `src/lib/ai/evidence.ts` (`brandKey`), `src/lib/merchants*.ts` | Normalisiert Buchungstexte zu einem stabilen Händler-Schlüssel (z. B. „NETFLIX.COM 123“ → `netflix`). |
| Fixkosten-Erkennung | `src/lib/fixed.ts` | `isFixedExpense`, `fixedRowCategory`, `matchingFixedRow`: ordnet Buchungen Fixkosten-Kategorien und vorhandenen Fixkosten-Zeilen zu. |
| Fixkosten-Plan | `src/lib/fixed-plan.ts` | `synchronizeFixedPlan` gruppiert nach `fixedMerchantKey` + `fixedCardKey`, toleriert Beträge ±max(0,05 €; 1 %), legt `financeRows` mit `kind: "fixed"` an (max. 200). |
| Fälligkeiten | `src/lib/fixed-cost-schedule.ts` | `fixedBookingHistory`, `fixedCostSchedule`: Status `open/due/unconfirmed/booked`, erwartetes Zeitfenster, offener Betrag je Monat. |
| Abo-Erkennung | `src/lib/insights.ts` → `detectSubscriptions` | Gleicher `brandKey`, Abstände 25–35 Tage (≥ 3 Abbuchungen) oder 350–380 Tage (≥ 2), Betrag ±25 %; liefert `nextDate`, `monthlyCost`, `priceChange` (> 2 % und ≥ 0,50 €). |
| Doppelte Abbuchungen | `src/lib/insights.ts` | `detectDuplicateCharges`, `detectDuplicateFixedCosts`. |
| Kündigungshilfe | `src/lib/assistant/cancel.ts` | Vertragstypen (Streaming, Mobilfunk, Internet, Versicherung, Energie, Fitness, Software), typische Kündigungsregeln als Text, Kündigungsschreiben. |

Lücken:

- Es gibt **keine persistente Vertrags-Entität**. Abos werden bei jedem Rendern neu erkannt; Bestätigen,
  Ignorieren oder Bearbeiten ist nicht möglich.
- Nur monatliche und jährliche Intervalle; **vierteljährlich und halbjährlich fehlen**.
- Keine Kündigungsfrist, keine Mindestlaufzeit, kein Laufzeitende, keine Erinnerung an Fristen.
- Abos (`detectSubscriptions`) und Fixkosten (`financeRows` vom Typ `fixed`) sind zwei getrennte Welten;
  ein Vertrag kann in beiden auftauchen.

### 1.2 Kontostand und Prognose

- Kontostände kommen aus `settings.balances`, `accountSnapshots`, `pocketSnapshots`, `trBalances`,
  `amexBalanceSnapshots`.
- `src/lib/assistant/forecast.ts`: `buildForecastInput` + `projectAccounts` rechnen Tag für Tag bis zu
  12 Monate voraus (Gehalt, Fixkosten, Abos, AMEX-Abrechnung, geplante Einmalausgaben, Alltagsausgaben).
- `src/lib/assistant/pulse.ts` → `safeToSpend`: niedrigster Giro-Stand **bis zum nächsten Gehalt** minus
  Puffer, ergibt „pro Tag ausgebbar“. Wird nur im Chat ausgegeben, nicht im Dashboard.
- `src/lib/calc/index.ts` → `calculateDashboard`: `current`, `timeline`, `ninetyDays`, `plan`, `actual`.
- Das Dashboard (`src/components/overview.tsx`) zeigt Monatsüberschuss, KPIs, Budget, Nettovermögen,
  Sparziele und Insights – aber **keinen voraussichtlichen Kontostand zum Monatsende** und kein
  „frei verfügbar“.

### 1.3 Datenhaltung

- Der gesamte `AppState` liegt als ein JSON-Dokument in SQLite (`finance.state_json`,
  `src/lib/server/database.ts`). Neue **optionale** Felder im `appStateSchema` (`src/lib/types.ts`)
  brauchen **keine SQL-Migration**.
- Geräteübergreifendes Zusammenführen: `src/lib/account-finance-merge.ts` führt Arrays über `id` bzw.
  `key` zusammen; persönliche Änderungen gewinnen auf dem Gerät. Neue Arrays mit stabiler `id`
  funktionieren damit ohne Sonderlogik.

### 1.4 Benachrichtigungen

- `src/lib/notifications.ts` → `detectNotificationEvents`: Gehaltseingang, Budgetüberschreitung, große
  Abbuchung. Ausgeliefert über `src/components/pwa-notifications.tsx` (Browser-Notifications) und den
  Hintergrund-Wächter `src/lib/assistant/watch.ts` (Windows-Toasts).

### 1.5 KI-Assistent

- Lokales Modell: OpenVINO Model Server mit Qwen3-8B-int4 auf der NPU, nur Loopback
  (`http://127.0.0.1:8000/v3`, `FINANZBLICK_AI*`, siehe `docs/local-ai.md`).
- Hybrider Agent: deterministischer Intent-Router (`src/lib/assistant/tools.ts`, 45 Tools wie `query`,
  `budget`, `forecast`, `pulse`, `funds`, `cancel`, `networth`, `month_review`, `cleanup`, …),
  Ausführung in `agent.ts`, Änderungen nur über `operations.ts` (`previewChange` → Bestätigung →
  `applyOperations`, mit Undo).
- Der Agent läuft im Browser (`src/components/finance-assistant.tsx`); die Routen
  `/api/ai/assistant` (Intent-Erkennung mit reduziertem Kontext), `/api/ai/answer` (freie Antwort) und
  `/api/ai/summary` sprechen mit dem lokalen Modell.
- Proaktiv heute: Tages-Briefing, Monats-Puls, Hintergrund-Wächter, Insights-Panel im Dashboard
  (`src/components/finance-insights.tsx`).
- **Kein Seitenkontext**: `askAssistant(question)` in `src/lib/assistant-bus.ts` überträgt nur einen
  String. Der Assistent weiß nicht, welche Seite, welcher Monat, welche Filter oder welche ausgewählten
  Buchungen gerade sichtbar sind.
- Insights sind nicht wegklickbar, haben kein „Mehr dazu“ und erscheinen nicht als Badge am Chat-Button.

### 1.6 Mobile-Performance

Lighthouse Mobile (Produktions-Build, Kontomodus, nach dem UI-Umbau): `/` 55, `/umsaetze` 61,
`/budget` 59 (Desktop 95–96). Ursachen laut Analyse:

1. Im Kontomodus rendert das Layout einen **leeren State**; die Daten kommen erst clientseitig über
   `/api/finance` (`no-store`), werden validiert, zusammengeführt und dann synchron durch
   `calculateDashboard` gerechnet → spätes LCP, lange Main-Thread-Tasks (TBT).
2. `AiReviewAssistant` sitzt im gemeinsamen Layout und zieht KI- und Import-Module in das Start-Bundle.
3. `FinanceProvider` importiert `import/review` und `ai/auto-assign` statisch.
4. Doppelte Schema-Validierung und doppelte Berechnungen beim Start; nicht kritische Effekte
   (Benachrichtigungen, Wächter, Briefing) laufen sofort.

---

## 2. Soll-Zustand je Meilenstein

### M1 – Vertrags- & Abo-Erkennung + digitaler Vertragsordner

**Logik (rein, testbar): `src/lib/contracts.ts`**

- `detectContracts(state, today)` vereinigt drei Quellen und dedupliziert über den Händler-Schlüssel:
  1. wiederkehrende Abbuchungen aus dem Ledger (gleicher `brandKey`, ähnlicher Betrag, regelmäßiges
     Intervall),
  2. Fixkosten-Zeilen (`financeRows`, `kind: "fixed"`),
  3. manuell angelegte Verträge.
- Intervalle: **monatlich, vierteljährlich, halbjährlich, jährlich** (Median der Abstände mit
  Toleranzfenstern; mindestens 3 Abbuchungen für monatlich, 2 für längere Intervalle). Die bestehende
  `detectSubscriptions` bleibt unverändert und wird weiter genutzt, wo sie heute genutzt wird.
- Je Vertrag: stabile `id` (aus Händler-Schlüssel + Konto), Name, Kategorie, Vertragstyp (Wiederverwendung
  der Typregeln aus `cancel.ts`), aktueller Betrag, Monatsäquivalent, Intervall, letzte und nächste
  Abbuchung, Preisverlauf, Preiserhöhung, Quelle (`erkannt`/`Fixkosten`/`manuell`), Konfidenz.
- Kündigung: Kündigungsfrist (Tage/Wochen/Monate), Mindestlaufzeit bzw. Laufzeitende,
  automatische Verlängerung. Daraus wird der **späteste Kündigungstermin** berechnet. Ist nichts
  hinterlegt, steht dort „Frist unbekannt – eintragen“; es werden **keine Rechtsauskünfte erfunden**.
  Die typischen Regeln aus `cancel.ts` erscheinen nur als Hinweis.
- `contractReminders(contracts, today)`: Fristen in den nächsten 30 Tagen, Preiserhöhungen, ausbleibende
  Abbuchungen.

**Persistenz (ohne SQL-Migration)**

- Neues optionales Feld im `appStateSchema`: `contracts` – Liste von Nutzer-Overrides
  `{ id, status: "confirmed" | "ignored" | "cancelled", name?, category?, amount?, interval?,
  nextDate?, noticePeriod?, termEnd?, autoRenew?, note?, manual?, updatedAt }`.
- Erkennung + Overrides werden zur Laufzeit zusammengeführt. Ignorierte Verträge tauchen nirgends mehr
  auf (auch nicht in Prognose und Insights). Merge über `id` funktioniert mit der bestehenden
  Zusammenführung.

**UI**

- Neue Route `/vertraege` (`src/app/(dashboard)/vertraege/page.tsx` + `loading.tsx`):
  - Kopf: Summe pro Monat und pro Jahr, Anzahl aktiver Verträge, nächste Abbuchung.
  - Abschnitte „Bald fällig / Fristen“, „Aktiv“, „Neu erkannt – bitte prüfen“, „Ignoriert / gekündigt“.
  - Zeile/Karte je Vertrag: Händler-Logo (bestehendes Merchant-Mark), Betrag, Intervall, nächster
    Termin, Fristhinweis, Preiserhöhungs-Badge; Aktionen *Bestätigen*, *Ignorieren*, *Bearbeiten*,
    *Als gekündigt markieren*, *Kündigung vorbereiten* (öffnet den Chat mit dem bestehenden
    Kündigungsschreiben).
  - Bearbeiten-Dialog (bestehende Dialog-Komponente) inkl. „Vertrag manuell anlegen“.
  - Mobile als Kartenliste, Desktop als Tabelle; Dark Mode über die vorhandenen Tokens.
- Navigation: Eintrag „Verträge“ in Sidebar, globaler Suche und im „Mehr“-Bereich der Bottom-Bar
  (die fünf Haupt-Tabs bleiben unverändert).
- Dashboard: kompakte Karte „Verträge“ (Monatssumme, nächste Abbuchung, offene Prüfungen, nächste
  Frist) mit Link zum Ordner.
- Benachrichtigungen: neue Ereignistypen `contract-deadline` und `contract-price` in
  `detectNotificationEvents` (PWA) und im Wächter.

**Tests**: Erkennung (monatlich/vierteljährlich/halbjährlich/jährlich, schwankende Beträge,
Preiserhöhung, Einmalzahlung wird nicht erkannt, Dedup Fixkosten ↔ Abo), Overrides
(bestätigen/ignorieren/bearbeiten/manuell), Kündigungstermin-Berechnung, Benachrichtigungen,
Schema-Roundtrip und Merge.

### M2 – Kontostand-Prognose & frei verfügbares Geld

**Logik: `src/lib/month-forecast.ts`**

- `monthEndForecast(state, dashboard, today)` nutzt `buildForecastInput`/`projectAccounts` und ergänzt
  bestätigte bzw. manuelle Verträge, die dort noch nicht enthalten sind (Dedup über Händler-Schlüssel,
  ignorierte Verträge werden ausgeschlossen).
- Ergebnis:
  - **Startsaldo** und Herkunft („Kontostand vom 12.11.“ bzw. „geschätzt“),
  - **erwartete Eingänge** bis Monatsende (Gehalt, sofern noch nicht eingegangen),
  - **feste Abgänge** bis Monatsende: offene Fixkosten (`fixedCostSchedule`), Verträge, geplante
    Einmalausgaben, AMEX-Abrechnung,
  - **erwartete Alltagsausgaben** (verbleibendes Budget bzw. Tagesdurchschnitt),
  - **voraussichtlicher Kontostand am Monatsende**, tiefster Stand im Verlauf,
  - **frei verfügbar** = Kontostand am Monatsende ohne Alltagsausgaben − Puffer,
    plus „pro Tag“ für die restlichen Tage,
  - Tagesverlauf (Punkte für die Visualisierung).
- Ohne bekannten Kontostand: kein erfundener Wert, sondern ein Leerzustand mit Link zu den
  Einstellungen.
- `safeToSpend` (bis zum Gehalt) bleibt unverändert; die neue Funktion ergänzt die Monatsende-Sicht.

**UI**

- Prominente Karte „Frei verfügbar bis Monatsende“ direkt im Dashboard-Kopf: große Zahl, „≈ x € pro Tag“,
  voraussichtlicher Kontostand am Monatsende, Mini-Verlauf (Recharts-Linie, bereits vorhanden, lazy)
  oder Fortschrittsbalken, die nächsten 3 Abbuchungen, Herkunft des Kontostands.
- Aufklappbare Aufschlüsselung (Start → + Eingänge → − Fixkosten/Verträge → − geplante Ausgaben →
  − Puffer = frei verfügbar).

**Tests**: Monatsanfang/-mitte/-ende, Gehalt bereits eingegangen bzw. offen, keine Doppelzählung
Fixkosten/Verträge, ignorierte Verträge, unbekannter Kontostand, negativer Saldo.

### M3 – Mobile Performance

Vorgehen: zuerst messen, dann gezielt optimieren, danach erneut messen.

1. **Messung Ausgangslage** mit Lighthouse Mobile (Produktions-Build, Kontomodus, synthetische Daten,
   3 Läufe je Seite, Median) für `/`, `/umsaetze`, `/budget`, `/vertraege`.
2. **Server-seitiger Start-State im Kontomodus**: `(dashboard)/layout.tsx` liest den gespeicherten State
   des angemeldeten Kontos über die bestehende Datenbankfunktion und übergibt ihn samt Revision an den
   `FinanceProvider`. Die Revision- und Merge-Semantik von `AccountFinanceStorage` bleibt erhalten
   (lokal noch nicht gespeicherte Änderungen werden nicht überschrieben). Die Auth-Logik selbst wird nicht
   verändert; es wird nur die bereits vorhandene Session gelesen.
3. **Lazy Loading**: `AiReviewAssistant` erst bei Bedarf laden; `import/review` und `ai/auto-assign` im
   `FinanceProvider` per dynamischem Import (die Module selbst bleiben unverändert).
4. **Weniger Arbeit beim Start**: doppelte Validierung vermeiden, teure Berechnungen (Insights,
   Nettovermögen, Verträge, Prognose) memoisiert und mit `useDeferredValue`/Idle-Callback;
   Benachrichtigungen, Briefing und Wächter-Abgleich erst nach dem ersten Rendern.
5. **Suspense-Grenzen und Skelette** für die nachgelagerten Dashboard-Karten.
6. **Caching**: `/api/finance` bleibt `no-store` (Datenkonsistenz); statische Assets und Icons erhalten
   lange Cache-Header über Next; Service-Worker-Strategie wird geprüft.
7. **Messung danach** und Dokumentation in `docs/PERFORMANCE.md` (Methode, Ursachen, Maßnahmen,
   Vorher/Nachher-Tabelle, verbleibende Engpässe).

Ziel: Mobile-Score möglichst nahe an 90. Realistische Erwartung: deutliche Verbesserung (≥ 75); der Rest
hängt an der Größe des clientseitigen Rechenkerns, der laut Auftrag nicht grundlegend umgebaut wird.

### M4 – KI zum Finanz-Copiloten ausbauen

**Kontextbewusstsein**

- Neues Modul `src/lib/assistant-context.ts`: Typ `AssistantPageContext`
  `{ route, title, month, filters?, selection?: { ids, count, sum }, visible?: { count, sum, ids? } }`
  und ein kleiner Client-Store (`useAssistantContext`), in den Seiten ihren Zustand melden
  (Umsätze: Filter, Suche, Auswahl; Budget/Sparen/Verträge: Monat, gewählter Vertrag).
- `askAssistant` akzeptiert zusätzlich `{ text, context?, insightId? }`; der bisherige String-Aufruf
  funktioniert unverändert.
- Neues Tool `context` im Intent-Router: „die angezeigten Buchungen“, „diese/ausgewählte Buchungen“,
  „auf dieser Seite“ → Summe, Anzahl, Top-Händler und -Kategorien, mögliche Doppelbuchungen,
  unklare Kategorien, jeweils mit Verweis auf die Seite.
- Die KI-Routen erhalten den Kontext **optional** und nur als kompakte Zusammenfassung (Zahlen,
  Kategorien, keine Rohdaten); bestehende Request-Schemas bleiben gültig.

**Neue bzw. erweiterte Fähigkeiten**

| Frage / Aufgabe | Umsetzung |
|---|---|
| „Welche Abos habe ich?“, „Wann läuft Netflix aus?“, „Was kostet mich Spotify im Jahr?“ | neues Tool `contracts` auf Basis von `src/lib/contracts.ts` (Liste, Einzelvertrag, Frist, Preisverlauf); `cancel` bleibt für Kündigungen |
| „Wie viel kann ich noch ausgeben?“, „Wie viel bleibt am Monatsende?“ | `pulse`/`forecast` nutzen `monthEndForecast` (frei verfügbar, pro Tag, Monatsende) |
| „Wo gebe ich mehr aus als letzten Monat?“ | Trend-Vergleich Vormonat und Ø 3 Monate je Kategorie (Erweiterung `pulse`/`month_review`) |
| Einzelne Buchungen, Händler, Sparziele, Nettovermögen | bestehende Tools `booking`, `query`, `savings_goal`, `networth`, um Kontext ergänzt |
| „Was fällt dir auf?“ | neues Tool `insights` (aktuelle proaktive Hinweise, sortiert nach Wichtigkeit) |

- Antworten bleiben strukturiert (Zahl, kurze Liste, Link zur passenden Seite) und knapp.
- Unsicherheit wird ausgesprochen: „Dazu habe ich keine ausreichenden Daten“ inkl. Begründung
  (z. B. kein Kontostand, weniger als 3 Monate Historie, Frist nicht hinterlegt).

**Proaktive Insights: `src/lib/copilot-insights.ts`**

`buildCopilotInsights(state, dashboard, today)` → `CopilotInsight[]` mit stabiler `id`, `kind`,
Schweregrad, Titel, Text, Betrag, Link und einem vorbereiteten Chat-Prompt. Geplante Typen
(mindestens 3 werden gefordert, geplant sind 7):

1. **Ungewöhnliche Ausgaben** – Kategorie deutlich über dem Durchschnitt (`unusualCategories`).
2. **Preiserhöhung** bei Abo/Vertrag.
3. **Sparziel in Gefahr** – Rate bzw. Zieldatum nicht mehr erreichbar.
4. **Budgetüberschreitung** (bzw. zu schnelles Tempo) mit konkretem Vorschlag
   (Umschichtung aus einer Kategorie mit Rest, als `budget_plan`-Vorschau zum Bestätigen).
5. **Kündigungsfrist** läuft in ≤ 30 Tagen ab.
6. **Mögliche Doppelbuchung** (`detectDuplicateCharges`).
7. **Unklare Kategorisierung** (offene Prüfungen, „Sonstiges“-Häufung) mit vorbereiteter Korrektur.

Aktionen werden ausschließlich als Vorschau über `previewChange` vorbereitet; ausgeführt wird erst nach
Bestätigung im Chat (bestehendes Undo bleibt).

**Persistenz**: optionales Feld `dismissedInsights` (`{ id, at, until? }`) im `AppState`, damit
weggeklickte Hinweise geräteübergreifend weg bleiben; abgelaufene Einträge werden aufgeräumt.

**UX**

- Dashboard: Bereich „Hinweise“ mit dezenten Karten (Icon, Titel, eine Zeile, Betrag),
  Aktionen *Wegklicken* und *Mehr dazu* (öffnet den Chat mit Prompt und Kontext).
- Badge mit der Anzahl offener wichtiger Hinweise am Floating-Chat-Button; Berechnung erst nach dem
  ersten Rendern (Performance).
- Chat bleibt auf allen Seiten über den bestehenden Floating-Button erreichbar.

**Technik / Grenzen**

- Ausschließlich die bestehende lokale KI (OpenVINO/Qwen auf Loopback). **Keine neuen externen APIs.**
- Deterministische Tools zuerst; das Modell formuliert nur dort, wo es heute schon eingesetzt wird.
  Ist das Modell nicht erreichbar, antworten die neuen Tools trotzdem (rein regelbasiert).
- Die Logik in `src/lib/ai/` bleibt unverändert; Erweiterungen liegen in `src/lib/assistant/` und den
  neuen Modulen. Bestehende Routing-Tests und Eval-Fälle werden ergänzt, nicht geändert.

**Tests**: Routing neuer Fragen (inkl. Negativbeispiele gegen Fehlrouting), `contracts`-, `context`- und
`insights`-Antworten, Insight-Erkennung je Typ, Dismiss-Logik, Kontext-Übergabe über den Bus,
Schema-Kompatibilität der KI-Routen.

---

## 3. Abhängigkeiten

**Keine neuen npm-Abhängigkeiten geplant.** Verwendet werden die vorhandenen Pakete: Recharts
(Verlauf), `motion` (Übergänge), TanStack Table (Vertragstabelle), Radix/shadcn-Bausteine (Dialoge),
`lucide-react` (Icons), Zod (Schemas), Lighthouse per `npx` (nur Messung, keine Abhängigkeit).
Falls doch etwas nötig wird, wird es hier mit Begründung nachgetragen.

## 4. Verifikation

Nach jedem Meilenstein (Gate, muss grün sein):

- `npm run typecheck`, `npm test`, `npm run lint`, `npm run build`
- KI-Tests `src/lib/ai/` separat (`vitest run src/lib/ai`)

Zusätzlich:

- Playwright `tests/responsive.spec.ts` um `/vertraege` und die neuen Dashboard-Karten erweitern
  (375 / 768 / 1440 px, kein horizontales Scrollen, Hell und Dunkel).
- API-Smoke-Test aller bestehenden `/api/`-Routen gegen die Baseline (unverändert).
- Lighthouse Mobile vorher/nachher → `docs/PERFORMANCE.md`.
- Abschluss: `docs/NEXT-FEATURES-SUMMARY.md` (Änderungen, Messwerte, offene Punkte).

## 5. Risiken und Gegenmaßnahmen

| Risiko | Gegenmaßnahme |
|---|---|
| Falsch erkannte Verträge (z. B. regelmäßiger Supermarkt-Einkauf) | Kategorie-Ausschlüsse (Lebensmittel, Tanken, Umbuchungen), Betrags- und Intervallstabilität, Konfidenz; Status „Neu erkannt – bitte prüfen“ statt automatisch aktiv; Ignorieren ist dauerhaft. |
| Doppelzählung in der Prognose (Fixkosten-Zeile und Vertrag) | Dedup über Händler-Schlüssel und Konto, eigene Tests. |
| Falsche Rechtsauskunft zu Kündigungsfristen | Fristen nur aus Nutzereingaben; typische Regeln nur als gekennzeichneter Hinweis. |
| Server-Start-State überschreibt lokale, noch nicht gespeicherte Änderungen | Bestehende Revision-/Merge-Logik wird wiederverwendet; Test für den Konfliktfall. |
| Zusätzliche Berechnungen verschlechtern die Mobile-Performance | Memoisierung, verzögerte Berechnung, Lazy Loading der neuen Bereiche; Messung in M3 nach M1/M2. |
| Neuer Intent fängt bestehende Fragen ab | Neue Regeln eng gefasst, Negativbeispiele und bestehende Routing-Tests als Absicherung. |
| Lighthouse 90 mobil nicht erreichbar ohne Umbau des Rechenkerns | Ehrliche Dokumentation der erreichten Werte und der verbleibenden Ursachen. |

## 6. Annahmen (bitte bei der Freigabe bestätigen oder korrigieren)

1. **„Frei verfügbar“** bezieht sich auf das Monatsende (wie im Auftrag); die bestehende Sicht „bis zum
   nächsten Gehalt“ bleibt im Chat erhalten.
2. **Kündigungsfristen** werden nicht aus externen Quellen geladen, sondern vom Nutzer eingetragen.
3. **Weggeklickte Hinweise und Vertragsentscheidungen** werden im `AppState` gespeichert und damit
   geräteübergreifend synchronisiert.
4. Die Mobile-Bottom-Bar bleibt bei fünf Einträgen; „Verträge“ ist dort über „Mehr“ erreichbar.
5. Kein Push zu GitHub, solange der Remote nicht erreichbar ist; Branches und Commits bleiben lokal.
