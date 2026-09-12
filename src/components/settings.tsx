"use client";

import { Controller, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Save, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useFinance } from "@/components/finance-provider";
import { PageHeading, SectionHeading } from "@/components/finance-ui";
import { settingsSchema, type Settings as SettingsData } from "@/lib/types";
import { localToday } from "@/lib/planning";

type NumericKey =
  | "emergencyTarget"
  | "vacationTarget"
  | "savingsTarget"
  | "bikeTarget"
  | "bikeShare"
  | "afterBikeSavingsShare"
  | "taxRate";
type DateKey = "bikePurchaseDate";
const withRateHistory = (settings: SettingsData): SettingsData => ({
  ...settings,
  interestRates: settings.interestRates ?? [
    { date: "2026-01-01", rate: settings.oldRate },
    { date: settings.rateChangeDate, rate: settings.newRate },
  ],
});
export function Settings() {
  const { state, update } = useFinance();
  const form = useForm<SettingsData>({
    resolver: zodResolver(settingsSchema),
    defaultValues: withRateHistory(state.settings),
  });
  const rates =
    useWatch({ control: form.control, name: "interestRates" }) ?? [];
  const bikeShare = useWatch({ control: form.control, name: "bikeShare" });
  const savingsShare = useWatch({
    control: form.control,
    name: "afterBikeSavingsShare",
  });
  const numericField = (
    name: NumericKey,
    label: string,
    percentage = false,
  ) => (
    <div key={name}>
      <Label htmlFor={name}>{label}</Label>
      <Controller
        name={name}
        control={form.control}
        render={({ field }) => (
          <div className="relative mt-2">
            <Input
              id={name}
              className="editable pr-10"
              type="number"
              min={0}
              max={percentage ? 100 : 1_000_000_000}
              step="0.01"
              name={field.name}
              ref={field.ref}
              onBlur={field.onBlur}
              value={
                Number.isNaN(field.value)
                  ? ""
                  : percentage
                    ? Number((field.value * 100).toFixed(6))
                    : field.value
              }
              onChange={(event) =>
                field.onChange(
                  event.target.value === ""
                    ? NaN
                    : Number(event.target.value) / (percentage ? 100 : 1),
                )
              }
            />
            <span className="pointer-events-none absolute top-2.5 right-3 text-xs text-muted-foreground">
              {percentage ? "%" : "€"}
            </span>
          </div>
        )}
      />
      {form.formState.errors[name] && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {form.formState.errors[name]?.message}
        </p>
      )}
    </div>
  );
  const dateField = (name: DateKey, label: string) => (
    <div key={name}>
      <Label htmlFor={name}>{label}</Label>
      <Input
        id={name}
        className="editable mt-2"
        type="date"
        {...form.register(name)}
      />
      {form.formState.errors[name] && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {form.formState.errors[name]?.message}
        </p>
      )}
    </div>
  );
  return (
    <>
      <PageHeading
        eyebrow="KONFIGURATION"
        title="Einstellungen"
        description="Ziele, Termine und die Regeln für deinen Sparplan."
      />
      <form
        onSubmit={form.handleSubmit((settings) => {
          settings.interestRates = [...new Map(settings.interestRates?.map((item) => [item.date, item])).values()].sort((a, b) => a.date.localeCompare(b.date));
          update((current) => ({ ...current, settings: { ...settings, asOf: current.settings.asOf, baselineDate: current.settings.baselineDate, balances: current.settings.balances } }));
          form.reset(settings);
          toast.success("Einstellungen gespeichert");
        })}
        className="space-y-5"
      >
        <div className="grid gap-5 xl:grid-cols-2">
          <section id="motorrad" className="panel p-5 sm:p-6">
            <SectionHeading
              title="Motorrad"
              subtitle="Alle Zielbeträge in Euro"
            />
            <div className="grid gap-5 sm:grid-cols-2">
              {numericField("bikeTarget", "Motorrad")}
              {dateField("bikePurchaseDate", "Motorrad kaufen am")}
            </div>
            <details id="sparziele" className="mt-5">
              <summary className="cursor-pointer text-sm">
                Weitere Sparziele
              </summary>
              <div className="mt-4 grid gap-5 sm:grid-cols-2">
                {numericField(
                  "emergencyTarget",
                  "Notgroschen · Trade Republic",
                )}
                {numericField("vacationTarget", "Urlaub")}
                {numericField("savingsTarget", "Sparkonto")}
              </div>
            </details>
          </section>
          <section className="panel p-5 sm:p-6">
            <SectionHeading
              title="Verteilung des Überschusses"
              subtitle="Der verbleibende Anteil wird automatisch zugeordnet."
            />
            <div className="space-y-5">
              {numericField("bikeShare", "Bis zum Ziel → Motorrad", true)}
              <p className="-mt-3 text-xs text-muted-foreground">
                Rest {Number(((1 - bikeShare) * 100).toFixed(2))} % → Sparkonto
              </p>
              {numericField(
                "afterBikeSavingsShare",
                "Nach dem Ziel → Sparkonto",
                true,
              )}
              <p className="-mt-3 text-xs text-muted-foreground">
                Rest {Number(((1 - savingsShare) * 100).toFixed(2))} % → Urlaub
              </p>
            </div>
          </section>
          <section id="tr-zinsen" className="panel p-5 sm:p-6">
            <SectionHeading
              title="Trade Republic & KESt"
              subtitle="Notgroschen · monatliche Nettoverzinsung"
            />
            <div className="grid gap-5 sm:grid-cols-2">
              {numericField("taxRate", "Kapitalertragsteuer", true)}
            </div>
            <div className="mt-5 space-y-3">
              {rates.map((_, index) => (
                <div className="grid grid-cols-2 gap-3" key={index}>
                  <label className="text-xs">
                    Gültig ab
                    <Input
                      type="date"
                      aria-label={`Zinssatz ${index + 1} gültig ab`}
                      {...form.register(`interestRates.${index}.date`)}
                    />
                  </label>
                  <label className="text-xs">
                    Zinssatz (%)
                    <Controller
                      name={`interestRates.${index}.rate`}
                      control={form.control}
                      render={({ field }) => (
                        <Input
                          type="number"
                          min="0"
                          max="100"
                          step="0.01"
                          aria-label={`Zinssatz ${index + 1}`}
                          value={
                            field.value === undefined ||
                            Number.isNaN(field.value)
                              ? ""
                              : Number((field.value * 100).toFixed(6))
                          }
                          onChange={(event) =>
                            field.onChange(
                              event.target.value === ""
                                ? NaN
                                : Number(event.target.value) / 100,
                            )
                          }
                        />
                      )}
                    />
                  </label>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  form.setValue(
                    "interestRates",
                    [
                      ...rates,
                      {
                        date: localToday(),
                        rate: rates.at(-1)?.rate ?? state.settings.newRate,
                      },
                    ],
                    { shouldDirty: true },
                  )
                }
              >
                Zinsänderung hinzufügen
              </Button>
              {form.formState.errors.interestRates && (
                <p role="alert" className="text-xs text-destructive">
                  Zinssatz und Datum prüfen.
                </p>
              )}
            </div>
          </section>
        </div>
        {form.formState.isDirty && (
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-card p-4">
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <ShieldCheck className="size-4 text-primary" />
              {form.formState.isDirty
                ? "Ungespeicherte Änderungen"
                : "Einstellungen sind gespeichert"}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                type="button"
                disabled={!form.formState.isDirty}
                onClick={() => form.reset(withRateHistory(state.settings))}
              >
                Verwerfen
              </Button>
              <Button type="submit" disabled={!form.formState.isDirty}>
                <Save className="size-4" />
                Einstellungen speichern
              </Button>
            </div>
          </div>
        )}
      </form>
    </>
  );
}
