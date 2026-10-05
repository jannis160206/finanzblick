"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent variant="confirmation" onCloseAutoFocus={(event) => { event.preventDefault(); returnFocus(); }}>
      <DialogHeader>
        <DialogTitle>Name nachschlagen</DialogTitle>
        <DialogDescription>Händler auswählen · Banktext bleibt erhalten.</DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-3 text-sm">
        {results === null ? <p role="status">Name wird gesucht …</p> : !results.length ? <p>Kein passender Name gefunden.</p> :
          <fieldset className="space-y-2">
            <legend className="sr-only">Suchergebnisse</legend>
            {results.map((result) => {
              const short = result.displayName.split(",").slice(0, 3).join(", ").slice(0, 160);
              return <label key={result.id} className="flex items-start gap-3 rounded-md border p-3" title={result.displayName}>
                <input type="radio" name="merchant-result" value={result.id} checked={selected === result.id}
                  onChange={() => setSelected(result.id)} className="mt-1 accent-primary" />
                <span>{short}{short.length < result.displayName.length ? " …" : ""}</span>
              </label>;
            })}
          </fieldset>}
      </DialogBody>
      <DialogFooter>
        <span className="mr-auto text-xs text-muted-foreground">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a></span>
        <Button variant="outline" onClick={onClose}>Abbrechen</Button>
        <Button disabled={!choice || disabled} onClick={() => { if (choice) onConfirm(choice); }}>Diesen Namen verwenden</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
