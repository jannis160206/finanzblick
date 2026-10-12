"use client";

import { CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function ErrorPage({ retry }: { retry: () => void }) {
  return (
    <section role="alert" className="panel mx-auto max-w-lg p-8 text-center">
      <CircleAlert className="mx-auto mb-4 size-8 text-destructive" />
      <h1 className="text-xl font-semibold">
        Ansicht konnte nicht geladen werden
      </h1>
      <p className="my-4 text-sm text-muted-foreground">
        Gespeicherte Finanzdaten bleiben erhalten.
      </p>
      <Button onClick={retry}>Erneut versuchen</Button>
    </section>
  );
}
