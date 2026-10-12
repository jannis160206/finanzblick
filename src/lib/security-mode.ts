export const SECURITY_MODE_KEY = "finanzblick.security-mode";
export const SECURITY_FALLBACK_KEY = "finanzblick.security-mode-lock";
export const SECURITY_AUTO_LOCK_KEY = "finanzblick.security-mode-auto-lock";
export const SECURITY_ACTIVATION_KEY = "finanzblick.security-mode-activation";

export type SecurityActivationPreference = "automatic" | "manual" | "off";

export type SecuritySnapshot = {
  locked: boolean;
  ready: boolean;
  error: string | null;
  preference: SecurityActivationPreference;
};

export const serverSecuritySnapshot: SecuritySnapshot = {
  locked: true,
  ready: false,
  error: null,
  preference: "automatic",
};

const readError = "Der Sicherheitsmodus konnte nicht geladen werden. Deine Finanzdaten bleiben weichgezeichnet.";
const temporaryError = "Der Sicherheitsmodus konnte nicht dauerhaft gespeichert werden. Der Sichtschutz bleibt in diesem Tab aktiv.";
const blockedError = "Der Browser blockiert das Speichern. Der Sichtschutz bleibt jetzt aktiv, kann nach einem Neuladen aber nicht garantiert werden.";
const invalidError = "Die gespeicherte Sicherheitseinstellung ist ungültig. Deine Finanzdaten bleiben weichgezeichnet.";
let snapshot = serverSecuritySnapshot;
let forcedLock = false;
let forcedError = temporaryError;
let automaticLock = false;
type SecurityWrite = {
  preference: SecurityActivationPreference;
  locked: boolean;
  automatic: boolean;
  savePreference: boolean;
};
let pendingWrite: SecurityWrite | undefined;
let filePickerClick: MouseEvent | null = null;
let filePickerTimeout: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

export const securityModeBootstrap = `(()=>{
  let locked=true,phase="read";
  const modeKey=${JSON.stringify(SECURITY_MODE_KEY)},fallbackKey=${JSON.stringify(SECURITY_FALLBACK_KEY)},autoKey=${JSON.stringify(SECURITY_AUTO_LOCK_KEY)},preferenceKey=${JSON.stringify(SECURITY_ACTIVATION_KEY)};
  delete document.documentElement.dataset.securityModeError;
  try{
    const preference=localStorage.getItem(preferenceKey)??"automatic";
    const value=localStorage.getItem(modeKey),fallback=sessionStorage.getItem(fallbackKey),automatic=sessionStorage.getItem(autoKey);
    const valid=value=>value===null||value==="true"||value==="false";
    if(!["automatic","manual","off"].includes(preference)||![value,fallback,automatic].every(valid)){phase="invalid";throw new Error();}
    locked=fallback==="true"||(preference!=="off"&&(value==="true"||automatic==="true"));
    phase="write";
    if(fallback!=="true"&&preference==="off"){
      if(value==="true")localStorage.setItem(modeKey,"false");
      if(automatic!==null)sessionStorage.removeItem(autoKey);
    }else if(preference==="automatic"&&document.visibilityState==="hidden"){
      locked=true;
      localStorage.setItem(modeKey,"true");
      sessionStorage.setItem(autoKey,"true");
    }
  }catch{
    locked=true;
    document.documentElement.dataset.securityModeError=phase;
    if(phase==="write"){
      try{sessionStorage.setItem(fallbackKey,"true");}
      catch{document.documentElement.dataset.securityModeError="blocked";}
    }
  }
  document.documentElement.dataset.securityMode=locked?"locked":"open";
})();`;

function isPreference(value: unknown): value is SecurityActivationPreference {
  return value === "automatic" || value === "manual" || value === "off";
}

function readPreference() {
  const preference = localStorage.getItem(SECURITY_ACTIVATION_KEY) ?? "automatic";
  if (!isPreference(preference)) throw new Error(invalidError);
  return preference;
}

function isStoredBoolean(value: string | null) {
  return value === null || value === "false" || value === "true";
}

function publish(next: SecuritySnapshot) {
  document.documentElement.dataset.securityMode = next.locked ? "locked" : "open";
  if (snapshot.locked === next.locked && snapshot.ready === next.ready && snapshot.error === next.error &&
    snapshot.preference === next.preference) return;
  snapshot = next;
  listeners.forEach((listener) => listener());
}

function refresh(leaving = false) {
  let value: string | null;
  let fallback: string | null;
  let automatic: string | null;
  let preference: SecurityActivationPreference;
  try {
    preference = readPreference();
    value = localStorage.getItem(SECURITY_MODE_KEY);
    fallback = sessionStorage.getItem(SECURITY_FALLBACK_KEY);
    automatic = sessionStorage.getItem(SECURITY_AUTO_LOCK_KEY);
    if (![value, fallback, automatic].every(isStoredBoolean)) throw new Error(invalidError);
  } catch (error) {
    publish({ ...snapshot, locked: true, ready: true, error: error instanceof Error && error.message === invalidError ? invalidError : readError });
    return;
  }
  if (forcedLock || fallback === "true") {
    publish({ locked: true, ready: true, preference, error: forcedLock ? forcedError : temporaryError });
    return;
  }
  if (preference === "off") {
    if (value === "true" || automatic !== null) {
      writeSecurityMode({ preference, locked: false, automatic: false, savePreference: false });
    } else {
      automaticLock = false;
      publish({ locked: false, ready: true, preference, error: null });
    }
    return;
  }
  automaticLock ||= automatic === "true";
  if (preference === "automatic" && (leaving || document.visibilityState === "hidden")) {
    if (!automaticLock || automatic !== "true") {
      automaticLock = true;
      writeSecurityMode({ preference, locked: true, automatic: true, savePreference: false });
      return;
    }
  }
  publish({ locked: automaticLock || value === "true", ready: true, preference, error: null });
}

function onStorage(event: StorageEvent) {
  if (event.key === SECURITY_MODE_KEY || event.key === SECURITY_FALLBACK_KEY ||
    event.key === SECURITY_AUTO_LOCK_KEY || event.key === SECURITY_ACTIVATION_KEY || event.key === null) refresh();
}

function lockOnLeave() {
  clearFilePicker();
  refresh(true);
}

function clearFilePicker() {
  filePickerClick = null;
  clearTimeout(filePickerTimeout);
  filePickerTimeout = undefined;
}

function onFilePickerClick(event: MouseEvent) {
  const input = event.target;
  clearFilePicker();
  if (!(input instanceof HTMLInputElement) || input.type !== "file" || input.disabled) return;
  if (event.defaultPrevented || snapshot.locked || document.visibilityState === "hidden") return;
  filePickerClick = event;
  filePickerTimeout = setTimeout(clearFilePicker, 1_000);
}

function onFilePickerClose(event: Event) {
  if (event.target === filePickerClick?.target) clearFilePicker();
}

function onWindowBlur() {
  const click = filePickerClick;
  clearFilePicker();
  // The native file picker blurs the window, but is not a switch away from the app.
  if (click && !click.defaultPrevented && click.target instanceof HTMLInputElement &&
    click.target.isConnected && !click.target.disabled && click.target.type === "file" &&
    document.visibilityState !== "hidden") return;
  lockOnLeave();
}

function onWindowReturn() {
  clearFilePicker();
  refresh();
}

function onVisibilityChange() {
  if (document.visibilityState === "hidden") lockOnLeave();
  else refresh();
}

export function subscribeSecurityMode(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener("storage", onStorage);
    window.addEventListener("pageshow", onWindowReturn);
    window.addEventListener("focus", onWindowReturn);
    window.addEventListener("blur", onWindowBlur);
    document.addEventListener("click", onFilePickerClick, true);
    document.addEventListener("change", onFilePickerClose, true);
    document.addEventListener("cancel", onFilePickerClose, true);
    document.addEventListener("visibilitychange", onVisibilityChange);
    const bootstrapError = document.documentElement.dataset.securityModeError;
    if (bootstrapError) {
      forcedLock = true;
      forcedError = bootstrapError === "invalid" ? invalidError : bootstrapError === "read" ? readError :
        bootstrapError === "blocked" ? blockedError : temporaryError;
    }
    refresh();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("pageshow", onWindowReturn);
      window.removeEventListener("focus", onWindowReturn);
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("click", onFilePickerClick, true);
      document.removeEventListener("change", onFilePickerClose, true);
      document.removeEventListener("cancel", onFilePickerClose, true);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearFilePicker();
    }
  };
}

export const getSecuritySnapshot = () => snapshot;
export const getServerSecuritySnapshot = () => serverSecuritySnapshot;

function failWrite(error = temporaryError) {
  forcedLock = true;
  try {
    sessionStorage.setItem(SECURITY_FALLBACK_KEY, "true");
  } catch {
    error = blockedError;
  }
  forcedError = error;
  publish({ ...snapshot, locked: true, ready: true, error });
}

function writeSecurityMode(write: SecurityWrite) {
  const { locked, automatic, preference, savePreference } = write;
  if (locked) publish({ ...snapshot, locked: true, ready: true });
  try {
    localStorage.setItem(SECURITY_MODE_KEY, String(locked));
    if (automatic) sessionStorage.setItem(SECURITY_AUTO_LOCK_KEY, "true");
    else sessionStorage.removeItem(SECURITY_AUTO_LOCK_KEY);
    sessionStorage.removeItem(SECURITY_FALLBACK_KEY);
    // Commit the preference only after its lock transition has been persisted.
    if (savePreference) localStorage.setItem(SECURITY_ACTIVATION_KEY, preference);
  } catch {
    pendingWrite = write;
    failWrite();
    return;
  }
  pendingWrite = undefined;
  forcedLock = false;
  automaticLock = automatic;
  delete document.documentElement.dataset.securityModeError;
  publish({ locked, ready: true, preference, error: null });
}

export function setSecurityMode(locked: boolean) {
  let preference: SecurityActivationPreference;
  try {
    preference = readPreference();
  } catch (error) {
    publish({ ...snapshot, locked: true, ready: true, error: error instanceof Error && error.message === invalidError ? invalidError : readError });
    return;
  }
  if (preference === "off") return;
  writeSecurityMode({ preference, locked, automatic: locked && automaticLock, savePreference: false });
}

export const toggleSecurityMode = () => setSecurityMode(!snapshot.locked);

export function setSecurityPreference(preference: SecurityActivationPreference) {
  if (!isPreference(preference)) {
    pendingWrite = undefined;
    failWrite(invalidError);
    return;
  }
  clearFilePicker();
  const automatic = preference === "automatic" &&
    (automaticLock || document.visibilityState === "hidden");
  writeSecurityMode({
    preference,
    locked: preference !== "off" && (snapshot.locked || automatic),
    automatic,
    savePreference: true,
  });
}

export function retrySecurityMode() {
  if (pendingWrite) {
    let write = pendingWrite;
    if (!write.savePreference) {
      try {
        const preference = readPreference();
        write = { ...write, preference, automatic: preference === "automatic" && write.automatic };
        if (preference === "off") write = { ...write, locked: false, automatic: false };
      } catch (error) {
        publish({ ...snapshot, locked: true, ready: true, error: error instanceof Error && error.message === invalidError ? invalidError : readError });
        return;
      }
    }
    if (write.preference === "automatic" && document.visibilityState === "hidden") {
      writeSecurityMode({ ...write, locked: true, automatic: true });
    } else writeSecurityMode(write);
  } else setSecurityPreference(snapshot.preference);
}
