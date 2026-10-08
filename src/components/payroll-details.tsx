import { PayrollDisclosure } from "@/components/payroll-ui";
import {
  payrollEstimate,
  payrollMoney,
  payrollPeriod,
  type PayrollPresentation,
} from "@/components/payroll-presentation";
import { payrollTaxSources } from "@/lib/payroll-analysis";
import { currency, monthLabel } from "@/lib/format";

export function PayrollDetails({ view }: { view: PayrollPresentation }) {
  const {
    analysis,
    latest,
    actual,
    year,
    next,
    bonus,
    projectedMonths,
    rough,
    uncertain,
  } = view;
  return (
    <div className="space-y-3">
      {projectedMonths.length > 0 && (
        <PayrollDisclosure
          title="Monatliche Prognose anzeigen"
          label="Monatliche Gehaltsprognose"
        >
          <div className="max-h-96 overflow-auto">
            <table
              className="w-full text-left text-sm"
              aria-label="Monatliche Gehaltsprognose"
            >
              <thead className="sticky top-0 bg-card">
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="p-2">Monat · Schätzung</th>
                  <th className="p-2 text-right">Laufendes Brutto</th>
                  <th className="p-2 text-right">Sonderzahlung</th>
                  <th className="p-2 text-right">Jahressechstel</th>
                </tr>
              </thead>
              <tbody>
                {projectedMonths.map((month) => {
                  const forecast = analysis.forecast.months.find(
                    (entry) => entry.month === month.month,
                  );
                  return (
                    <tr key={month.month} className="border-b last:border-0">
                      <th
                        scope="row"
                        className="p-2 text-left font-normal whitespace-nowrap"
                      >
                        {monthLabel(payrollPeriod(year, month.month))}
                      </th>
                      <td className="p-2 text-right whitespace-nowrap tabular-nums">
                        {payrollMoney(forecast?.regularGross)}
                      </td>
                      <td className="p-2 text-right whitespace-nowrap tabular-nums">
                        {payrollMoney(
                          analysis.hasSpecialPaymentModel
                            ? forecast?.specialGross
                            : undefined,
                        )}
                      </td>
                      <td className="p-2 text-right whitespace-nowrap tabular-nums">
                        {payrollEstimate(month)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </PayrollDisclosure>
      )}
      <PayrollDisclosure
        title="Berechnungsdetails, Annahmen & Quellen"
        label="Berechnungsdetails"
      >
        <div className="space-y-4 text-xs leading-relaxed text-muted-foreground">
          {actual && (
            <dl className="grid gap-3 sm:grid-cols-3">
              <div>
                <dt>Laufende Basis seit Jänner</dt>
                <dd className="mt-1 tabular-nums">
                  {payrollMoney(actual.regularGrossYtd)}
                </dd>
              </div>
              <div>
                <dt>Sonderzahlungen bisher · brutto</dt>
                <dd className="mt-1 tabular-nums">
                  {payrollMoney(actual.specialGrossYtd)}
                </dd>
              </div>
              <div>
                <dt>Verbleibendes Brutto-Sechstel</dt>
                <dd className="mt-1 tabular-nums">
                  {payrollMoney(actual.remaining)}
                </dd>
              </div>
            </dl>
          )}
          {analysis.issues.length > 0 && (
            <div className="space-y-2">
              {analysis.issues.map((issue, index) => (
                <p key={index}>{issue}</p>
              ))}
            </div>
          )}
          {rough && (
            <p>
              Für{" "}
              {analysis.estimatedHistoryMonths
                .map((month) => monthLabel(payrollPeriod(year, month)))
                .join(", ")}{" "}
              fehlt die laufende Bruttobasis. Nur die separat angezeigte
              Jahressechstel-Schätzung verwendet hierfür den Durchschnitt der
              verfügbaren vollen Monatsabrechnungen. Ist-Werte,
              Sechstelverbrauch und Steuer werden daraus nicht abgeleitet.
            </p>
          )}
          {uncertain && (
            <p>
              Die tarifbesteuerte VEB-Prämie ist mit der SV-Sonderzahlungsbasis
              abgeglichen. Laufende Tarifbesteuerung allein belegt keine
              Sechstelerhöhung (§ 67 Abs. 10 EStG). Die Spanne enthält deshalb
              beide Varianten: ohne und mit Einbeziehung in die laufende
              Sechstelbasis. Die Prämie wird nicht monatlich fortgeschrieben.
              Ein später belegter kumulierter laufender Bruttostand ersetzt
              diese Spanne; eine gesicherte Steuerrechnung benötigt zusätzlich
              belegte Verbrauchswerte.
            </p>
          )}
          {latest && (
            <div className="space-y-2">
              <p>
                Prämien-Spielraum: kleinster verbleibender Brutto-Sechstelbetrag
                vom gewählten Auszahlungsmonat bis Dezember, nach Abzug
                bisheriger und geplanter Sonderzahlungen. Das berücksichtigt
                auch ein sinkendes Sechstel und das Kontrollsechstel. Bereits
                gezahlte Sonderzahlungen werden vorsichtig vollständig
                reserviert, auch wenn sie früher teilweise tarifbesteuert
                wurden. Das kann den tatsächlich verfügbaren Spielraum
                unterschätzen. Eine offene Prämie wird unten vollständig als
                Verbrauch, oben mit dem belegten Mindestverbrauch angesetzt;
                dies sind Grenzen, keine bestätigte Steuerzuordnung.
              </p>
              <p>
                Das 1.000-€-Beispiel unterstellt eine zusätzliche
                SV-Sonderzahlung, die vollständig dem laufenden Tarif
                unterliegt. Es vergleicht die fortgeschriebene laufende
                LSt-Basis ohne und mit dieser isolierten Zahlung. Es ist keine
                Simulation einer größeren Prämie aus Spielraum plus 1.000 €:
                weitere gleichzeitige Überhänge können den Tarif erhöhen. Die SV
                wird anhand der gesamten modellierten Monats-Sonderzahlung
                einschließlich Beispiel und bisheriger Jahres-SV-Basis
                proportional aufgeteilt. Beitragssatzsprünge können auch Abzüge
                der übrigen Sonderzahlung verändern. Persönliche Abzüge bleiben
                unverändert; begünstigte Steuersätze oberhalb der 6-%-Stufe und
                die tatsächliche Prämienvereinbarung sind gesondert zu beachten.
              </p>
              {[...bonus.headroomIssues, ...bonus.taxIssues].map(
                (issue, index) => (
                  <p key={index}>{issue}</p>
                ),
              )}
            </div>
          )}
          {next && (
            <dl className="grid gap-3 sm:grid-cols-3">
              <div>
                <dt>Sonderzahlung innerhalb des Sechstels · Modell</dt>
                <dd className="mt-1 tabular-nums">
                  {currency(next.eligibleGross)}
                </dd>
              </div>
              <div>
                <dt>Tarifpflichtiger Überhang · Modell</dt>
                <dd className="mt-1 tabular-nums">
                  {currency(next.overflowGross)}
                </dd>
              </div>
              <div>
                <dt>Auszahlungsanteil nach SV und Lohnsteuer · Modell</dt>
                <dd className="mt-1 tabular-nums">
                  {payrollMoney(next.tax?.netSpecial)}
                </dd>
              </div>
            </dl>
          )}
          {next?.taxIssues.length ? (
            <div className="space-y-2">
              {next.taxIssues.map((issue, index) => (
                <p key={index}>{issue}</p>
              ))}
            </div>
          ) : null}
          <div className="space-y-2" aria-label="Automatische Modellannahmen">
            {(next?.taxAssumptions ?? analysis.assumptions).map(
              (assumption, index) => (
                <p key={index}>{assumption}</p>
              ),
            )}
          </div>
          <p>
            Das Kontrollsechstel am Jahresende beträgt laufendes Jahresbrutto /
            6. Schätzungen sind keine endgültige Lohnabrechnung oder
            individuelle Steuerberatung. Die Auswertung erfolgt getrennt je
            Arbeitgeber; Aufrollungen und Sonderfälle können abweichen.
          </p>
          <p>
            Rechtsstand 18.09.2026:{" "}
            {payrollTaxSources.map((source, index) => (
              <span key={source.href}>
                {index > 0 && " · "}
                <a
                  className="break-words text-primary underline"
                  href={source.href}
                  target="_blank"
                  rel="noreferrer"
                >
                  {source.label}
                </a>
              </span>
            ))}
          </p>
        </div>
      </PayrollDisclosure>
    </div>
  );
}
