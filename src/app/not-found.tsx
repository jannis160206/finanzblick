import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <section className="panel mx-auto max-w-lg p-8 text-center">
      <p className="eyebrow mb-3">404</p>
      <h1 className="text-xl font-semibold">Seite nicht gefunden</h1>
      <Button asChild className="mt-6">
        <Link href="/">Zur Übersicht</Link>
      </Button>
    </section>
  );
}
