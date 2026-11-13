"use client";

import { useState } from "react";
import { MapPin, SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ChoiceCards, DialogEmpty, DialogSkeleton, Field, PremiumDialog, PremiumDialogBody, PremiumDialogContent, PremiumDialogFooter, PremiumDialogHeader,
} from "@/components/ui/premium-dialog";
import type { MerchantLookupResult } from "@/lib/merchant-lookup-schema";

export function MerchantLookupDialog({ results, onConfirm, onClose, returnFocus, disabled }: {
  results: MerchantLookupResult[] | null;
  onConfirm: (result: MerchantLookupResult) => void;
  onClose: () => void;
  returnFocus: () => void;
  disabled: boolean;
}) {
  const [selected, setSelected] = useState("");
  const choice = results?.find((result) => result.id === selected);
  return <PremiumDialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <PremiumDialogContent size="sm" variant="confirmation" onCloseAutoFocus={(event) => { event.preventDefault(); returnFocus(); }}>
      <PremiumDialogHeader icon={MapPin} title="Name nachschlagen" description="Händler auswählen · Banktext bleibt erhalten." />
      <PremiumDialogBody className="space-y-3 text-sm">
        {results === null ? <DialogSkeleton rows={3} label="Name wird gesucht …" /> : !results.length
          ? <DialogEmpty icon={SearchX} title="Kein passender Name gefunden">Der Banktext bleibt unverändert.</DialogEmpty>
          : <Field label="Suchergebnisse" group>
              <ChoiceCards className="grid-cols-1" value={selected} onValueChange={setSelected} options={results.map((result) => {
                const parts = result.displayName.split(",").map((part) => part.trim());
                const rest = parts.slice(1, 3).join(", ");
                return { value: result.id, label: parts[0].slice(0, 80), ...(rest ? { description: rest.slice(0, 120) } : {}) };
              })} />
            </Field>}
      </PremiumDialogBody>
      <PremiumDialogFooter>
        <span className="text-xs text-muted-foreground sm:mr-auto">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a></span>
        <Button variant="outline" onClick={onClose}>Abbrechen</Button>
        <Button disabled={!choice || disabled} onClick={() => { if (choice) onConfirm(choice); }}>Diesen Namen verwenden</Button>
      </PremiumDialogFooter>
    </PremiumDialogContent>
  </PremiumDialog>;
}
