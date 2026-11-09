"use client";

import { CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function ErrorPage({ retry }: { retry: () => void }) {
  return (
    <section role="alert" className="panel mx-auto flex max-w-lg flex-col items-center p-8 text-center sm:p-10">
      <span aria-hidden="true" className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-destructive-soft text-destructive">
        <CircleAlert className="size-6" />
      </span>
      <h1 className="text-xl font-semibold tracking-tight">
        Ansicht konnte nicht geladen werden
      </h1>
      <p className="mt-2 mb-6 text-sm text-muted-foreground">
        Gespeicherte Finanzdaten bleiben erhalten.
      </p>
      <Button onClick={retry}>Erneut versuchen</Button>
    </section>
  );
}
