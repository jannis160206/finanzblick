# Next Features – Zusammenfassung

Umsetzung des Plans aus `docs/NEXT-FEATURES-PLAN.md`: Vertragsordner, Kontostand-Prognose, Mobile-Performance
und KI-Copilot. Jeder Meilenstein ist ein eigener Commit auf einem eigenen, aufeinander aufbauenden Branch:

| Meilenstein | Branch | Commit |
|---|---|---|
| Plan | `features/m1-contracts` | `6746d8a` docs: plan next features |
| M1 Verträge & Abos | `features/m1-contracts` | `1ad7a45` feat(contracts) |
| M2 Prognose & frei verfügbar | `features/m2-forecast` | `02c0222` feat(forecast) |
| M3 Mobile Performance | `features/m3-performance` | `86b9c0c` perf |
| M4 KI-Copilot | `features/m4-copilot` | `7c1ac9c` feat(copilot) |

Neue npm-Abhängigkeiten: **keine**. Datenbank: **keine SQL-Migration nötig** – neue Felder (`contracts`,
`dismissedInsights`) sind optionale Teile des bestehenden JSON-Finanzstands und werden geräteübergreifend
über die vorhandene Merge-Logik (nach `id`) abgeglichen. Auth-Logik, Import-Pipelines (`src/lib/import/`) und
die KI-Logik in `src/lib/ai/` sind unverändert.

## M1 – Vertrags- & Abo-Erkennung, digitaler Vertragsordner

- **Erkennung** (`src/lib/contracts.ts`): gleicher Händler, ähnlicher Betrag (±25 %) und regelmäßiger Abstand –
  monatlich, vierteljährlich, halbjährlich, jährlich. Fixkosten aus dem Monatsplan werden verknüpft statt
  doppelt gezählt; eigene Verträge lassen sich manuell anlegen. Preisänderungen, ausgebliebene Abbuchungen,
  nächster Termin, Jahreskosten.
- **Kündigungsfristen**: aus eingetragener Frist, Mindestlaufzeit und automatischer Verlängerung wird der letzte
  Kündigungstag berechnet; typische österreichische Fristen werden als Hinweis gezeigt (nie als Rechtsberatung).
- **Seite `/vertraege`**: laufende Kosten nach Vertragsart, nächste 30 Tage, Hinweise, „Neu erkannt“ mit
  *Ist ein Vertrag* / *Kein Vertrag* (mit Rückgängig), gruppierte Liste (laufend/beendet/ausgeblendet),
  Detail-Panel mit Abbuchungen, Bearbeiten/Anlegen, *Als gekündigt markieren*, *Kündigung vorbereiten*
  (öffnet den Assistenten). Mobil Kartenliste, Desktop Spaltenansicht.
- **Integration**: Karte „Verträge & Abos“ in der Übersicht, Navigationseintrag, PWA-Benachrichtigungen für
  Fristen (≤ 30 Tage) und Preiserhöhungen.

## M2 – Kontostand-Prognose & frei verfügbares Geld

- `src/lib/month-forecast.ts`: Kontostand heute + erwartete Eingänge − offene Fixkosten − Verträge
  (ohne Doppelzählung mit Fixkosten/Amex, gekündigte nur bis zum Ende) − Kreditkarten-Abbuchung − Sparraten
  − geplante Ausgaben. **Frei verfügbar** = tiefster Stand im Restmonat minus Puffer, dazu pro Tag,
  Kontostand am Monatsende inkl. geplanter Alltagsausgaben und Tagesverlauf.
- Übersicht: Karte **„Frei verfügbar bis …“** direkt unter Überschuss und Kennzahlen, mit Verlauf (Stufendiagramm
  mit Puffer-Linie), nächsten Abbuchungen und aufklappbarer Rechnung. Ohne Kontostand kein erfundener Wert,
  sondern ein klarer Hinweis.

## M3 – Mobile Performance

Details, Methode und Messwerte in `docs/PERFORMANCE.md`. Kurz (Lighthouse Mobile, Median aus 3 Läufen,
1.097 synthetische Buchungen, HTTPS, identischer Aufbau vorher/nachher):

| Seite | Mobile | LCP | TBT | Desktop |
|---|---|---|---|---|
| `/` | 40 → **76** | 10,8 s → 1,4 s | 10,7 s → 1,1 s | 57 → **100** |
| `/umsaetze` | 44 → **79** | 11,4 s → 1,4 s | 6,3 s → 0,9 s | 55 → **100** |
| `/budget` | 41 → **74** | 12,0 s → 1,4 s | 6,1 s → 1,5 s | 71 → **95** |
| `/vertraege` | 45 → **76** | 10,2 s → 1,4 s | 5,5 s → 1,2 s | 59 → **94** |

Maßnahmen: serverseitig gerenderter Kontostand im Kontomodus (sofort sichtbar, bis zum Laden schreibgeschützt),
kein doppelter Abruf, Web Worker für Aufbereitung, KI-Vorzuordnung, Automatik-Abgleich und Dashboard-Auswertungen
(gleiche Funktionen, unveränderte Logik), Wiederverwendung berechneter Dashboards, Transitions statt langer Tasks.

## M4 – KI als Finanz-Copilot

- **Kontext**: Seiten melden ihren Zustand an `src/lib/assistant-context.ts` (Umsätze: Filter, angezeigte und
  ausgewählte Buchungen; Verträge: geöffneter Vertrag). Der Kontext bleibt im Browser.
- **Neue Werkzeuge** (regelbasiert, ohne Modell beantwortbar): `contracts` (Liste, einzelner Vertrag, Jahreskosten,
  Frist, Preisverlauf), `context` (Summe, Kategorien, Händler, mögliche Doppelbuchungen, unklare Kategorien der
  angezeigten/ausgewählten Buchungen), `insights`. Der Monats-Puls beantwortet „Wie viel kann ich noch ausgeben?“
  und „Wie viel bleibt am Monatsende?“ aus der Prognose und vergleicht Kategorien mit dem Vormonat zum gleichen
  Tag („Wo gebe ich mehr aus als letzten Monat?“).
- **Proaktive Hinweise** (`src/lib/copilot-insights.ts`, 8 Typen): knappes Monatsende, Budget überschritten bzw.
  zu schnell (mit konkretem Umschicht-Vorschlag), Kündigungsfrist, Preiserhöhung, Sparziel in Gefahr, mögliche
  Doppelbuchung, ungewöhnliche Ausgaben, unklare Kategorien. Sichtbar in der Übersicht („Hinweise“: wegklicken
  mit Rückgängig, *Mehr dazu* fragt sofort im Chat) und als Zahl am Assistenten-Button.
- **Aktionen nur mit Bestätigung**: *Mehr dazu* bei einer Budgetüberschreitung erzeugt die Umschichtung als
  Vorschau (`budget_plan`), unklare Kategorien als Zuordnungs-Vorschau (`cleanup`), Fristen führen zur
  Kündigungshilfe. Ausgeführt wird erst nach *Bestätigen*, Rückgängig bleibt möglich.
- **Ehrliche Antworten**: fehlender Kontostand, fehlende Frist, fehlende Vormonatsdaten oder fehlende Auswahl
  werden ausdrücklich genannt („Dazu habe ich keine ausreichenden Daten …“).
- Antworten können auf die passende Seite verlinken (z. B. „Im Vertragsordner öffnen“).

## Akzeptanzkriterien

| Kriterium | Ergebnis |
|---|---|
| Vertragsordner zeigt erkannte wiederkehrende Zahlungen korrekt an | ✅ Erkennung inkl. Intervallen, Fixkosten-Verknüpfung, Overrides; Unit-, Komponenten- und Screenshot-Prüfung |
| Dashboard zeigt Prognose und frei verfügbares Geld | ✅ Karte „Frei verfügbar bis Monatsende“ |
| Mobile Performance messbar verbessert, Zahlen dokumentiert | ✅ 40–45 → 74–79 Mobile, 55–71 → 94–100 Desktop (`docs/PERFORMANCE.md`) |
| KI beantwortet Fragen zu Verträgen, Prognosen und Budgets | ✅ Werkzeuge `contracts`, `pulse` (Monatsende), `budget_plan`/`budget`, Routing- und Antwort-Tests |
| Mindestens 3 proaktive Insight-Typen im Dashboard | ✅ 8 Typen, Panel „Hinweise“ + Badge |
| Bestehende Tests und API-Routen funktionieren | ✅ `npm test` 4.782 bestanden; API-Smoke 57 Probes identisch zur Baseline (Ausnahme `/api/market`, s. u.) |
| Nutzbar auf 375, 768, 1440 px | ✅ `tests/responsive.spec.ts` + `tests/a11y.spec.ts` (inkl. `/vertraege`): 18/18 |
| Keine TypeScript- oder Linter-Fehler | ✅ `npm run typecheck`, `npm run lint`, `npm run build` grün |

## Offene Punkte und Hinweise

- **Kein Push / keine PRs**: Das GitHub-Repository ist von hier aus nicht erreichbar („Repository not found“).
  Die vier Branches liegen lokal gestapelt vor und können als Stacked PRs in der Reihenfolge M1 → M4 geöffnet werden.
- **Mobile 90 nicht ganz erreicht** (74–79 bei ~1.100 Buchungen): verbleibend sind React-Hydration großer Seiten
  sowie die Ableitungen der Budget- und Umsatzseite im ersten Render. Weitere Schritte wären serverseitig
  vorberechnete Budget-Istwerte und kleinere Seiten-Chunks (siehe `docs/PERFORMANCE.md`).
- **E2E `tests/dashboard.spec.ts`**: 7 von 9 Fällen schlagen in dieser Umgebung fehl – identisch auch auf dem
  Stand vor diesen Features (`d44bb6c`). Sie hängen von der lokalen Excel-Startdatei bzw. festen Daten ab;
  keine Regression.
- **API-Smoke `/api/market`**: in der Baseline Zeitüberschreitung, jetzt 200 – die Route holt Live-Marktdaten aus
  dem Internet und ist netzwerkabhängig; Code unverändert.
- **Seitenkontext nicht an das Modell**: Abweichend vom Plan („optional an die KI-Routen“) bleibt der Kontext
  vollständig im Browser; die neuen Fragen werden regelbasiert erkannt, das Request-Schema der KI-Route bleibt
  unverändert. Das schützt die Daten und hält `src/lib/ai/` unverändert.
- **Kündigungsfristen** kennt Finanzblick nur, wenn sie eingetragen werden; ohne Frist gibt es den Hinweis auf
  übliche Fristen, aber keine Erinnerung.
- **Weggeklickte Hinweise** kommen zurück, wenn ein neuer Anlass entsteht (neue ID, z. B. nächster Monat oder
  neue Frist); ein „Später erinnern“ mit Datum ist noch nicht umgesetzt.
- Die Hinweis-Badge rechnet auf jeder Seite im Worker mit; bei sehr großen Haushaltsbüchern kostet das
  Hintergrund-Rechenzeit, aber keine Hauptthread-Zeit.
