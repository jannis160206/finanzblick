export const SECURITY_MODE_KEY = "finanzblick.security-mode";
export const SECURITY_FALLBACK_KEY = "finanzblick.security-mode-lock";
export const SECURITY_AUTO_LOCK_KEY = "finanzblick.security-mode-auto-lock";

type SecuritySnapshot = {
  locked: boolean;
  ready: boolean;
  error: string | null;
};

export const serverSecuritySnapshot: SecuritySnapshot = {
  locked: true,
  ready: false,
  error: null,
};

const readError = "Der Sicherheitsmodus konnte nicht geladen werden. Deine Finanzdaten bleiben ausgeblendet.";
const temporaryError = "Der Sicherheitsmodus konnte nicht dauerhaft gespeichert werden. Der Sichtschutz bleibt in diesem Tab aktiv.";
let snapshot = serverSecuritySnapshot;
let forcedLock = false;
let automaticLock = false;
let filePickerClick: MouseEvent | null = null;
let filePickerTimeout: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

export const securityModeBootstrap = `(()=>{let locked=true;try{const value=localStorage.getItem(${JSON.stringify(SECURITY_MODE_KEY)});const fallback=sessionStorage.getItem(${JSON.stringify(SECURITY_FALLBACK_KEY)});const automatic=sessionStorage.getItem(${JSON.stringify(SECURITY_AUTO_LOCK_KEY)});const hidden=document.visibilityState==="hidden";locked=hidden||automatic==="true"||fallback==="true"||(value!==null&&value!=="false");if(hidden){localStorage.setItem(${JSON.stringify(SECURITY_MODE_KEY)},"true");sessionStorage.setItem(${JSON.stringify(SECURITY_AUTO_LOCK_KEY)},"true");}}catch{}document.documentElement.dataset.securityMode=locked?"locked":"open";})();`;

function publish(next: SecuritySnapshot) {
  document.documentElement.dataset.securityMode = next.locked ? "locked" : "open";
  if (snapshot.locked === next.locked && snapshot.ready === next.ready && snapshot.error === next.error) return;
  snapshot = next;
  listeners.forEach((listener) => listener());
}

function refresh() {
  if (forcedLock) {
    publish({ locked: true, ready: true, error: temporaryError });
    return;
  }
  let value: string | null;
  let fallback: string | null;
  let automatic: string | null;
  try {
    value = localStorage.getItem(SECURITY_MODE_KEY);
    fallback = sessionStorage.getItem(SECURITY_FALLBACK_KEY);
    automatic = sessionStorage.getItem(SECURITY_AUTO_LOCK_KEY);
  } catch {
    publish({ locked: true, ready: true, error: readError });
    return;
  }
  automaticLock ||= automatic === "true";
  if (fallback === "true") {
    publish({ locked: true, ready: true, error: temporaryError });
  } else if (automaticLock) {
    publish({ locked: true, ready: true, error: null });
  } else if (value === null || value === "false" || value === "true") {
    publish({ locked: value === "true", ready: true, error: null });
  } else {
    publish({ locked: true, ready: true, error: "Die gespeicherte Sicherheitseinstellung ist ungültig. Deine Finanzdaten bleiben ausgeblendet." });
  }
}

function onStorage(event: StorageEvent) {
  if (event.key === SECURITY_MODE_KEY || event.key === SECURITY_FALLBACK_KEY ||
    event.key === SECURITY_AUTO_LOCK_KEY || event.key === null) refresh();
}

function lockOnLeave() {
  clearFilePicker();
  if (automaticLock && snapshot.locked) return;
  automaticLock = true;
  writeSecurityMode(true, true);
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
    if (document.visibilityState === "hidden") lockOnLeave();
    else refresh();
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

function writeSecurityMode(locked: boolean, automatic: boolean) {
  if (locked) publish({ locked: true, ready: true, error: null });
  try {
    localStorage.setItem(SECURITY_MODE_KEY, String(locked));
    if (automatic) sessionStorage.setItem(SECURITY_AUTO_LOCK_KEY, "true");
    else sessionStorage.removeItem(SECURITY_AUTO_LOCK_KEY);
    sessionStorage.removeItem(SECURITY_FALLBACK_KEY);
  } catch {
    forcedLock = true;
    let error = temporaryError;
    try {
      sessionStorage.setItem(SECURITY_FALLBACK_KEY, "true");
    } catch {
      error = "Der Browser blockiert das Speichern. Der Sichtschutz bleibt jetzt aktiv, kann nach einem Neuladen aber nicht garantiert werden.";
    }
    publish({ locked: true, ready: true, error });
    return;
  }
  forcedLock = false;
  automaticLock = automatic;
  publish({ locked, ready: true, error: null });
}

export function setSecurityMode(locked: boolean) {
  writeSecurityMode(locked, locked && automaticLock);
}

export const toggleSecurityMode = () => setSecurityMode(!snapshot.locked);
