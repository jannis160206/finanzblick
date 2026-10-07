"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  ArrowRight,
  CircleAlert,
  Eye,
  EyeOff,
  Landmark,
  LoaderCircle,
  LockKeyhole,
  MonitorSmartphone,
  UserRound,
} from "lucide-react";
import { accountCredentialsSchema, accountLoginCredentialsSchema, accountUserSchema } from "@/lib/account-schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type AccountFormProps = {
  mode: "login" | "register";
  registrationEnabled?: boolean;
  storageWarning?: boolean;
};

type FieldErrors = Partial<Record<"username" | "password" | "confirmation", string>>;

const publicErrors = new Set([
  "Benutzername oder Passwort ist falsch.",
  "Dieser Benutzername ist nicht verfügbar.",
  "Die Registrierung ist deaktiviert.",
  "Zu viele Versuche. Bitte später erneut versuchen.",
]);

function publicError(payload: unknown, fallback: string): string {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) {
    return fallback;
  }
  return typeof payload.error === "string" && publicErrors.has(payload.error)
    ? payload.error
    : fallback;
}

export function AccountForm({ mode, registrationEnabled = true, storageWarning = false }: AccountFormProps) {
  const registering = mode === "register";
  const registrationClosed = registering && !registrationEnabled;
  const id = useId();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const submitting = useRef(false);

  function updateField(field: keyof FieldErrors, value: string) {
    if (field === "username") setUsername(value);
    if (field === "password") setPassword(value);
    if (field === "confirmation") setConfirmation(value);
    setFieldErrors((previous) => ({ ...previous, [field]: undefined }));
    setError(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || registrationClosed) return;

    const credentialsSchema = registering ? accountCredentialsSchema : accountLoginCredentialsSchema;
    const credentials = credentialsSchema.safeParse({
      username: username.trim(),
      password,
    });
    const nextErrors: FieldErrors = {};
    if (!accountCredentialsSchema.shape.username.safeParse(username.trim()).success) {
      nextErrors.username = "Bitte nutze 3–32 Zeichen: Buchstaben, Zahlen, Punkt, Bindestrich oder Unterstrich.";
    }
    if (!credentialsSchema.shape.password.safeParse(password).success) {
      nextErrors.password = registering ? "Dein Passwort muss 12–128 Zeichen lang sein." : "Bitte gib dein Passwort ein (höchstens 128 Zeichen).";
    }
    if (registering && password !== confirmation) {
      nextErrors.confirmation = "Die Passwörter stimmen nicht überein.";
    } else if (registering && !confirmation) {
      nextErrors.confirmation = "Bitte wiederhole dein Passwort.";
    }
    setFieldErrors(nextErrors);
    if (!credentials.success || Object.keys(nextErrors).length > 0) {
      setError("Bitte überprüfe deine Eingaben.");
      return;
    }

    submitting.current = true;
    setBusy(true);
    setError(null);
    let authenticated = false;
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(credentials.data),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const fallback = response.status === 401
          ? "Anmeldung fehlgeschlagen. Bitte überprüfe deinen Benutzernamen und dein Passwort."
          : registering
            ? "Dein Konto konnte nicht erstellt werden. Bitte versuche es erneut."
            : "Anmeldung nicht möglich. Bitte versuche es erneut.";
        setError(publicError(payload, fallback));
        return;
      }
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("user" in payload) ||
        !accountUserSchema.safeParse(payload.user).success
      ) {
        setError("Die Anmeldung konnte nicht bestätigt werden. Bitte versuche es erneut.");
        return;
      }
      authenticated = true;
      setPassword("");
      setConfirmation("");
      setShowPassword(false);
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- Discard React state and caches from a previous account.
      location.assign("/");
    } catch {
      setError("Verbindung fehlgeschlagen. Bitte prüfe deine Internetverbindung und versuche es erneut.");
    } finally {
      if (!authenticated) {
        submitting.current = false;
        setBusy(false);
      }
    }
  }

  const linkClasses = "inline-flex min-h-11 items-center rounded-lg font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <main className="dark relative isolate flex min-h-screen min-h-svh flex-col overflow-hidden bg-background px-5 py-6 text-foreground sm:px-8 sm:py-8">
      <div aria-hidden="true" className="pointer-events-none absolute -left-40 -top-64 -z-10 size-[44rem] rounded-full bg-primary/[0.06] blur-[100px]" />
      <div aria-hidden="true" className="pointer-events-none absolute -bottom-80 -right-72 -z-10 size-[48rem] rounded-full bg-primary/[0.04] blur-[100px]" />

      <header className="mx-auto flex w-full max-w-6xl items-center gap-3">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 text-primary">
          <Landmark aria-hidden="true" className="size-6" strokeWidth={1.75} />
        </div>
        <span className="text-xl font-semibold tracking-tight">Finanzblick<span className="text-primary">.</span></span>
      </header>

      <div className="mx-auto grid w-full max-w-6xl flex-1 items-center gap-10 py-12 sm:py-16 lg:grid-cols-[1.1fr_1fr] lg:gap-20">
        <section aria-labelledby={`${id}-intro`} className="mx-auto w-full max-w-md lg:mx-0 lg:max-w-lg">
          <p className="mb-5 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />
            Dein persönlicher Finanzüberblick
          </p>
          <h2 id={`${id}-intro`} className="text-4xl font-semibold leading-[1.12] tracking-tight sm:text-5xl lg:text-6xl">
            Deine Finanzen.<br />
            <span className="text-primary">Dein klarer Blick.</span>
          </h2>
          <p className="mt-6 max-w-sm text-base leading-relaxed text-muted-foreground">
            Einnahmen, Ausgaben und Ziele an einem Ort. Für weniger Suchen und mehr Überblick.
          </p>
          <div className="mt-9 hidden gap-5 sm:grid">
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-xl border border-border bg-card text-primary">
                <UserRound aria-hidden="true" className="size-5" strokeWidth={1.75} />
              </div>
              <div>
                <p className="text-sm font-medium">Ein Konto. Dein Überblick.</p>
                <p className="mt-1 text-xs text-muted-foreground">Dein persönlicher Zugang zu deinen Finanzdaten.</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-xl border border-border bg-card text-primary">
                <MonitorSmartphone aria-hidden="true" className="size-5" strokeWidth={1.75} />
              </div>
              <div>
                <p className="text-sm font-medium">Auf allen deinen Geräten.</p>
                <p className="mt-1 text-xs text-muted-foreground">Am Desktop planen. Unterwegs nachsehen.</p>
              </div>
            </div>
          </div>
        </section>

        <section aria-labelledby={`${id}-title`} className="mx-auto w-full max-w-md rounded-3xl border border-border bg-card p-6 shadow-[0_24px_80px_-28px_rgba(0,0,0,0.65)] sm:p-9">
          <div className="mb-7">
            <div className="mb-5 flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <LockKeyhole aria-hidden="true" className="size-5" strokeWidth={1.75} />
            </div>
            <h1 id={`${id}-title`} className="text-2xl font-semibold tracking-tight">
              {registering ? "Konto erstellen" : "Willkommen zurück"}
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {registering ? "Dein erster Schritt zu mehr Klarheit." : "Melde dich an und behalte deine Finanzen im Blick."}
            </p>
          </div>

          {storageWarning && <p role="alert" className="mb-5 text-sm leading-relaxed text-destructive">Du bist abgemeldet. Die lokale Kontosicherung konnte nicht entfernt werden. Bitte die Website-Daten im Browser löschen, wenn du das Gerät teilst.</p>}
          {registrationClosed ? (
            <div className="rounded-2xl border border-border bg-background/50 p-5">
              <p className="text-sm font-medium">Registrierung derzeit geschlossen</p>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Neue Konten können momentan nicht erstellt werden. Wenn du bereits ein Konto hast, kannst du dich anmelden.
              </p>
              <Link href="/login" prefetch={false} className={`${linkClasses} mt-3 gap-2 text-sm`}>
                Zur Anmeldung <ArrowRight aria-hidden="true" className="size-4" />
              </Link>
            </div>
          ) : (
            <>
              <form onSubmit={submit} noValidate aria-label={registering ? "Konto erstellen" : "Anmelden"} aria-busy={busy}>
                <fieldset disabled={busy} className="min-w-0 space-y-5">
                  <div className="space-y-2.5">
                    <Label htmlFor={`${id}-username`}>Benutzername</Label>
                    <Input
                      id={`${id}-username`}
                      name="username"
                      type="text"
                      autoComplete="username"
                      autoCapitalize="none"
                      spellCheck={false}
                      required
                      minLength={3}
                      maxLength={32}
                      value={username}
                      onChange={(event) => updateField("username", event.target.value)}
                      aria-invalid={Boolean(fieldErrors.username)}
                      aria-describedby={fieldErrors.username ? `${id}-username-error` : registering ? `${id}-username-help` : undefined}
                      className="h-12 rounded-xl bg-background/70 px-4"
                      placeholder="Dein Benutzername"
                    />
                    {fieldErrors.username ? (
                      <p id={`${id}-username-error`} className="text-xs leading-relaxed text-destructive">{fieldErrors.username}</p>
                    ) : registering ? (
                      <p id={`${id}-username-help`} className="text-xs leading-relaxed text-muted-foreground">3–32 Zeichen: Buchstaben, Zahlen, Punkt, - oder _</p>
                    ) : null}
                  </div>

                  <div className="space-y-2.5">
                    <Label htmlFor={`${id}-password`}>Passwort</Label>
                    <div className="relative">
                      <Input
                        id={`${id}-password`}
                        name="password"
                        type={showPassword ? "text" : "password"}
                        autoComplete={registering ? "new-password" : "current-password"}
                        required
                        minLength={registering ? 12 : 1}
                        maxLength={128}
                        value={password}
                        onChange={(event) => updateField("password", event.target.value)}
                        aria-invalid={Boolean(fieldErrors.password)}
                        aria-describedby={fieldErrors.password ? `${id}-password-error` : registering ? `${id}-password-help` : undefined}
                        className="h-12 rounded-xl bg-background/70 pl-4 pr-14"
                        placeholder={registering ? "Ein sicheres Passwort" : "Dein Passwort"}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute right-1 top-0.5 size-11 text-muted-foreground"
                        aria-label={showPassword ? "Passwort verbergen" : "Passwort anzeigen"}
                        aria-pressed={showPassword}
                        aria-controls={`${id}-password`}
                        onClick={() => setShowPassword((shown) => !shown)}
                      >
                        {showPassword ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                      </Button>
                    </div>
                    {fieldErrors.password ? (
                      <p id={`${id}-password-error`} className="text-xs leading-relaxed text-destructive">{fieldErrors.password}</p>
                    ) : registering ? (
                      <p id={`${id}-password-help`} className="text-xs leading-relaxed text-muted-foreground">Mindestens 12 Zeichen. Wähle eine einzigartige Passphrase.</p>
                    ) : null}
                  </div>

                  {registering && (
                    <div className="space-y-2.5">
                      <Label htmlFor={`${id}-confirmation`}>Passwort bestätigen</Label>
                      <Input
                        id={`${id}-confirmation`}
                        name="password-confirmation"
                        type={showPassword ? "text" : "password"}
                        autoComplete="new-password"
                        required
                        maxLength={128}
                        value={confirmation}
                        onChange={(event) => updateField("confirmation", event.target.value)}
                        aria-invalid={Boolean(fieldErrors.confirmation)}
                        aria-describedby={fieldErrors.confirmation ? `${id}-confirmation-error` : undefined}
                        className="h-12 rounded-xl bg-background/70 px-4"
                        placeholder="Passwort wiederholen"
                      />
                      {fieldErrors.confirmation && (
                        <p id={`${id}-confirmation-error`} className="text-xs leading-relaxed text-destructive">{fieldErrors.confirmation}</p>
                      )}
                    </div>
                  )}

                  {error && (
                    <div role="alert" className="flex items-start gap-2.5 rounded-xl border border-destructive/25 bg-destructive/10 p-3.5 text-sm leading-relaxed text-destructive">
                      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                      <p>{error}</p>
                    </div>
                  )}

                  <Button type="submit" disabled={busy} className="h-12 w-full text-sm font-semibold">
                    {busy ? (
                      <><LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" />{registering ? "Konto wird erstellt …" : "Anmeldung läuft …"}</>
                    ) : (
                      <>{registering ? "Konto erstellen" : "Anmelden"}<ArrowRight aria-hidden="true" /></>
                    )}
                  </Button>
                </fieldset>
              </form>

              <div className="mt-6 border-t border-border pt-4 text-center text-sm text-muted-foreground">
                {registering ? (
                  <>Bereits ein Konto?{" "}<Link href="/login" prefetch={false} aria-disabled={busy || undefined} onClick={(event) => { if (busy) event.preventDefault(); }} className={linkClasses}>Anmelden</Link></>
                ) : registrationEnabled ? (
                  <>Noch kein Konto?{" "}<Link href="/register" prefetch={false} aria-disabled={busy || undefined} onClick={(event) => { if (busy) event.preventDefault(); }} className={linkClasses}>Konto erstellen</Link></>
                ) : (
                  <p className="py-2 text-xs leading-relaxed">Neue Konten können derzeit nicht erstellt werden.</p>
                )}
              </div>
            </>
          )}
        </section>
      </div>

      <footer className="mx-auto w-full max-w-6xl text-center text-xs leading-relaxed text-muted-foreground lg:text-left">
        Deine Finanzen. Auf allen deinen Geräten.
      </footer>
    </main>
  );
}
