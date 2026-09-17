export const SECURITY_MODE_KEY = "finanzblick.security-mode";
export const SECURITY_FALLBACK_KEY = "finanzblick.security-mode-lock";

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
const listeners = new Set<() => void>();

export const securityModeBootstrap = `(()=>{let locked=true;try{const value=localStorage.getItem(${JSON.stringify(SECURITY_MODE_KEY)});const fallback=sessionStorage.getItem(${JSON.stringify(SECURITY_FALLBACK_KEY)});locked=fallback==="true"||(value!==null&&value!=="false");}catch{}document.documentElement.dataset.securityMode=locked?"locked":"open";})();`;

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
  try {
    value = localStorage.getItem(SECURITY_MODE_KEY);
    fallback = sessionStorage.getItem(SECURITY_FALLBACK_KEY);
  } catch {
    publish({ locked: true, ready: true, error: readError });
    return;
  }
  if (fallback === "true") {
    publish({ locked: true, ready: true, error: temporaryError });
  } else if (value === null || value === "false" || value === "true") {
    publish({ locked: value === "true", ready: true, error: null });
  } else {
    publish({ locked: true, ready: true, error: "Die gespeicherte Sicherheitseinstellung ist ungültig. Deine Finanzdaten bleiben ausgeblendet." });
  }
}

function onStorage(event: StorageEvent) {
  if (event.key === SECURITY_MODE_KEY || event.key === SECURITY_FALLBACK_KEY || event.key === null) refresh();
}

function onVisibilityChange() {
  if (document.visibilityState === "visible") refresh();
}

export function subscribeSecurityMode(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener("storage", onStorage);
    window.addEventListener("pageshow", refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibilityChange);
    refresh();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("pageshow", refresh);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
  };
}

export const getSecuritySnapshot = () => snapshot;
export const getServerSecuritySnapshot = () => serverSecuritySnapshot;

export function setSecurityMode(locked: boolean) {
  if (locked) publish({ locked: true, ready: true, error: null });
  try {
    localStorage.setItem(SECURITY_MODE_KEY, String(locked));
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
  publish({ locked, ready: true, error: null });
}

export const toggleSecurityMode = () => setSecurityMode(!snapshot.locked);
