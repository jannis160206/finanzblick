"use client";

import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Save, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useFinance } from "@/components/finance-provider";
import {
  InputLegend,
  PageHeading,
  SectionHeading,
} from "@/components/finance-ui";
import { settingsSchema, type Settings as SettingsData } from "@/lib/types";

type NumericKey =
  | "emergencyTarget"
  | "vacationTarget"
  | "savingsTarget"
  | "bikeTarget"
  | "bikeShare"
  | "afterBikeSavingsShare"
  | "oldRate"
  | "newRate"
  | "taxRate";
type DateKey =
  | "asOf"
  | "baselineDate"
  | "bikePurchaseDate"
  | "allocationStart"
  | "rateChangeDate"
  | "interestStart";
export function Settings() {
  const { state, update } = useFinance();
  const form = useForm<SettingsData>({
    resolver: zodResolver(settingsSchema),
    defaultValues: state.settings,
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
      >
        <InputLegend />
      </PageHeading>
      <form
        onSubmit={form.handleSubmit((settings) => {
          update((current) => ({ ...current, settings }));
          form.reset(settings);
          toast.success("Einstellungen gespeichert");
        })}
        className="space-y-5"
      >
        <div className="grid gap-5 xl:grid-cols-2">
          <section className="panel p-5 sm:p-6">
            <SectionHeading
              title="Sparziele"
              subtitle="Alle Zielbeträge in Euro"
            />
            <div className="grid gap-5 sm:grid-cols-2">
              {numericField("bikeTarget", "Motorrad")}
              {numericField("emergencyTarget", "Notgroschen")}
              {numericField("vacationTarget", "Urlaub")}
              {numericField("savingsTarget", "Sparkonto")}
            </div>
          </section>
          <section className="panel p-5 sm:p-6">
            <SectionHeading
              title="Termine & Stichtag"
              subtitle="Der Stichtag steuert Ist-Auswertung und Planfenster."
            />
            <div className="grid gap-5 sm:grid-cols-2">
              {dateField("asOf", "Auswertungsstichtag")}
              {dateField("baselineDate", "Datum der Ist-Basis")}
              {dateField("bikePurchaseDate", "Motorrad kaufen am")}
              {dateField("allocationStart", "Sparverteilung ab")}
            </div>
          </section>
          <section className="panel p-5 sm:p-6">
            <SectionHeading
              title="Verteilung des Überschusses"
              subtitle="Der verbleibende Anteil wird automatisch zugeordnet."
            />
            <div className="space-y-5">
              {numericField("bikeShare", "Bis zum Ziel → Motorrad", true)}
              <p className="-mt-3 text-xs text-muted-foreground">
                Rest → Sparkonto
              </p>
              {numericField(
                "afterBikeSavingsShare",
                "Nach dem Ziel → Sparkonto",
                true,
              )}
              <p className="-mt-3 text-xs text-muted-foreground">
                Rest → Urlaub
              </p>
            </div>
          </section>
          <section className="panel p-5 sm:p-6">
            <SectionHeading
              title="Trade Republic & KESt"
              subtitle="Notgroschen · monatliche Nettoverzinsung"
            />
            <div className="grid gap-5 sm:grid-cols-2">
              {numericField("oldRate", "Zins vor dem Wechsel", true)}
              {numericField("newRate", "Zins nach dem Wechsel", true)}
              {dateField("rateChangeDate", "Neuer Zinssatz ab")}
              {numericField("taxRate", "Kapitalertragsteuer", true)}
              {dateField("interestStart", "Verzinsung ab")}
            </div>
          </section>
        </div>
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
              onClick={() => form.reset(state.settings)}
            >
              Verwerfen
            </Button>
            <Button type="submit" disabled={!form.formState.isDirty}>
              <Save className="size-4" />
              Einstellungen speichern
            </Button>
          </div>
        </div>
      </form>
    </>
  );
}
