import Link from "next/link";
import { Compass } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <section className="panel mx-auto flex max-w-lg flex-col items-center p-8 text-center sm:p-10">
      <span aria-hidden="true" className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
        <Compass className="size-6" />
      </span>
      <h1 className="text-xl font-semibold tracking-tight">Seite nicht gefunden</h1>
      <p className="mt-2 text-sm text-muted-foreground">Diese Adresse gibt es nicht (mehr).</p>
      <Button asChild className="mt-6">
        <Link href="/">Zur Übersicht</Link>
      </Button>
    </section>
  );
}
