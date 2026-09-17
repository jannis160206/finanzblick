// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInteractionSounds,
  interactionSoundFor,
  interactionSoundInterval,
  interactionSoundsKey,
  interactionSoundsVolumeKey,
  defaultInteractionSoundsVolume,
} from "./interaction-sounds";

const parameter = () => ({
  setValueAtTime: vi.fn(),
  linearRampToValueAtTime: vi.fn(),
  exponentialRampToValueAtTime: vi.fn(),
});

function audioMock(state: AudioContextState = "running") {
  const oscillators: ReturnType<typeof oscillator>[] = [];
  const gains: ReturnType<typeof gain>[] = [];
  const oscillator = () => ({
    type: "",
    frequency: parameter(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    onended: null as (() => void) | null,
  });
  const gain = () => ({
    gain: parameter(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  });
  const audio = {
    state,
    currentTime: 2,
    destination: {},
    resume: vi.fn(() => {
      audio.state = "running";
      return Promise.resolve();
    }),
    close: vi.fn(() => {
      audio.state = "closed";
      return Promise.resolve();
    }),
    createOscillator: vi.fn(() => {
      const node = oscillator();
      oscillators.push(node);
      return node;
    }),
    createGain: vi.fn(() => {
      const node = gain();
      gains.push(node);
      return node;
    }),
  };
  const constructor = vi.fn(function () {
    audio.state = state;
    return audio;
  });
  vi.stubGlobal("AudioContext", constructor);
  return { audio, constructor, oscillators, gains };
}

function gesture(
  target: Element,
  overrides: Partial<MouseEvent> = {},
): MouseEvent {
  return {
    target,
    isTrusted: true,
    button: 0,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...overrides,
  } as MouseEvent;
}

let dispose: (() => void) | undefined;
let time = 0;

function mount() {
  const add = vi.spyOn(document, "addEventListener");
  const sounds = createInteractionSounds();
  dispose = sounds.mount();
  const click = add.mock.calls.find(([type]) => type === "click")![1] as (
    event: MouseEvent,
  ) => void;
  return { sounds, click };
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '<button id="action"><span>Action</span></button>';
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  time = 0;
  vi.spyOn(performance, "now").mockImplementation(() => time);
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("interaction targeting", () => {
  it("accepts only trusted primary activations, including keyboard clicks and nested icons", () => {
    const target = document.querySelector("span")!;
    expect(interactionSoundFor(gesture(target, { detail: 0 }))).toBe("click");
    for (const override of [
      { isTrusted: false },
      { button: 1 },
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
    ]) {
      expect(interactionSoundFor(gesture(target, override))).toBeNull();
    }
  });

  it.each([
    "<button disabled><span>Action</span></button>",
    '<button aria-disabled="true"><span>Action</span></button>',
    "<fieldset disabled><button><span>Action</span></button></fieldset>",
    "<div inert><button><span>Action</span></button></div>",
    "<div hidden><button><span>Action</span></button></div>",
    '<div data-interaction-sound="off"><button><span>Action</span></button></div>',
    "<div><span>Text</span></div>",
    '<label><span>Label forwards its click</span><input type="checkbox"></label>',
  ])(
    "keeps disabled, passive and explicitly silent targets quiet: %s",
    (markup) => {
      document.body.innerHTML = markup;
      expect(
        interactionSoundFor(gesture(document.querySelector("span")!)),
      ).toBeNull();
    },
  );

  it("distinguishes native checkbox state, ARIA toggles and navigation", () => {
    document.body.innerHTML =
      '<input type="checkbox"><button aria-pressed="false"></button><button role="switch" aria-checked="true"></button><a href="/plan">Plan</a><input type="text">';
    const checkbox = document.querySelector("input")!;
    checkbox.checked = true;
    expect(interactionSoundFor(gesture(checkbox))).toBe("on");
    checkbox.checked = false;
    expect(interactionSoundFor(gesture(checkbox))).toBe("off");
    expect(
      interactionSoundFor(gesture(document.querySelector("[aria-pressed]")!)),
    ).toBe("on");
    expect(
      interactionSoundFor(gesture(document.querySelector("[role=switch]")!)),
    ).toBe("off");
    expect(interactionSoundFor(gesture(document.querySelector("a")!))).toBe(
      "click",
    );
    expect(
      interactionSoundFor(gesture(document.querySelector("[type=text]")!)),
    ).toBeNull();
  });
});

describe("subtle interaction audio", () => {
  it("does not create audio on mount, typing, hover, synthetic clicks or preference reads", () => {
    const { constructor } = audioMock();
    const { sounds } = mount();
    const button = document.querySelector("button")!;
    button.click();
    button.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", bubbles: true }),
    );
    button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    sounds.setEnabled(true, new Event("change"));
    expect(constructor).not.toHaveBeenCalled();
  });

  it("schedules one quiet short enveloped sine click and disposes ended nodes", () => {
    const { audio, constructor, oscillators, gains } = audioMock();
    const { click } = mount();
    click(gesture(document.querySelector("span")!));
    expect(constructor).toHaveBeenCalledTimes(1);
    expect(audio.resume).not.toHaveBeenCalled();
    expect(oscillators[0].type).toBe("sine");
    expect(oscillators[0].start).toHaveBeenCalledWith(2);
    expect(oscillators[0].stop.mock.calls[0][0]).toBeCloseTo(2.098);
    expect(gains[0].gain.linearRampToValueAtTime).toHaveBeenCalledWith(
      0.12,
      2.006,
    );
    expect(gains[0].gain.linearRampToValueAtTime).toHaveBeenCalledWith(
      0.096,
      2.024,
    );
    expect(gains[0].gain.exponentialRampToValueAtTime.mock.calls[0][0]).toBe(
      0.0001,
    );
    oscillators[0].onended!();
    expect(oscillators[0].disconnect).toHaveBeenCalledOnce();
    expect(gains[0].disconnect).toHaveBeenCalledOnce();
    expect(oscillators[0].onended).toBeNull();
  });

  it("rate-limits rapid pointer and keyboard activations without queuing a later sound", () => {
    const { oscillators } = audioMock();
    const { click } = mount();
    const event = gesture(document.querySelector("button")!, { detail: 0 });
    click(event);
    for (time = 1; time < interactionSoundInterval; time++) click(event);
    expect(oscillators).toHaveLength(1);
    click(event);
    expect(oscillators).toHaveLength(2);
  });

  it("persists mute independently of finances, applies it immediately and previews only trusted enabling", () => {
    localStorage.setItem("finanzdashboard.v1", "financial data untouched");
    const { audio, constructor, oscillators, gains } = audioMock();
    const { sounds, click } = mount();
    const event = gesture(document.querySelector("button")!);
    click(event);
    sounds.setEnabled(false, event);
    expect(localStorage.getItem(interactionSoundsKey)).toBe("off");
    expect(localStorage.getItem("finanzdashboard.v1")).toBe(
      "financial data untouched",
    );
    expect(gains[0].disconnect).toHaveBeenCalledOnce();
    expect(audio.close).toHaveBeenCalledOnce();
    time = 200;
    click(event);
    expect(oscillators).toHaveLength(1);
    sounds.setEnabled(true, new Event("change"));
    expect(constructor).toHaveBeenCalledTimes(1);
    sounds.setEnabled(true, event);
    expect(oscillators).toHaveLength(2);
    expect(oscillators[1].frequency.setValueAtTime).toHaveBeenCalledWith(
      620,
      2,
    );
  });

  it("restores a muted preference without constructing audio", () => {
    localStorage.setItem(interactionSoundsKey, "off");
    const { constructor } = audioMock();
    const { sounds, click } = mount();
    click(gesture(document.querySelector("button")!));
    expect(sounds.getSnapshot().enabled).toBe(false);
    expect(constructor).not.toHaveBeenCalled();
  });

  it("retains stored mute even when the separate volume preference cannot be read", () => {
    const getItem = Storage.prototype.getItem;
    localStorage.setItem(interactionSoundsKey, "off");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (
      this: Storage,
      key: string,
    ) {
      if (key === interactionSoundsVolumeKey) throw new DOMException("Denied");
      return getItem.call(this, key);
    });
    const { constructor } = audioMock();
    const { sounds, click } = mount();
    click(gesture(document.querySelector("button")!));
    expect(sounds.getSnapshot()).toMatchObject({
      enabled: false,
      storageAvailable: false,
    });
    expect(constructor).not.toHaveBeenCalled();
  });

  it("persists volume without playing on slider changes and previews only on a trusted action", () => {
    const { constructor, gains } = audioMock();
    const { sounds } = mount();
    expect(sounds.getSnapshot().volume).toBe(defaultInteractionSoundsVolume);
    sounds.setVolume(100);
    expect(localStorage.getItem(interactionSoundsVolumeKey)).toBe("100");
    sounds.preview(new Event("click"));
    expect(constructor).not.toHaveBeenCalled();
    sounds.preview(gesture(document.querySelector("button")!));
    expect(gains[0].gain.linearRampToValueAtTime).toHaveBeenCalledWith(
      0.2,
      2.006,
    );
    time = 200;
    sounds.setVolume(25);
    sounds.preview(gesture(document.querySelector("button")!));
    expect(gains[1].gain.linearRampToValueAtTime).toHaveBeenCalledWith(
      0.05,
      2.006,
    );
  });

  it.each(["", "invalid", "-1", "101", "Infinity"])(
    "uses an audible default for invalid stored volume %s",
    (stored) => {
      localStorage.setItem(interactionSoundsVolumeKey, stored);
      const { constructor } = audioMock();
      const { sounds } = mount();
      expect(sounds.getSnapshot().volume).toBe(defaultInteractionSoundsVolume);
      expect(constructor).not.toHaveBeenCalled();
    },
  );

  it("restores volume, bounds updates and keeps zero volume synchronously silent", () => {
    localStorage.setItem(interactionSoundsVolumeKey, "35");
    const { audio, gains, oscillators } = audioMock();
    const { sounds, click } = mount();
    expect(sounds.getSnapshot().volume).toBe(35);
    const event = gesture(document.querySelector("button")!);
    click(event);
    sounds.setVolume(-10);
    expect(sounds.getSnapshot().volume).toBe(0);
    expect(gains[0].disconnect).toHaveBeenCalledOnce();
    expect(audio.close).toHaveBeenCalledOnce();
    time = 200;
    click(event);
    sounds.preview(event);
    expect(oscillators).toHaveLength(1);
    sounds.setVolume(NaN);
    expect(sounds.getSnapshot().volume).toBe(0);
    sounds.setVolume(120);
    expect(sounds.getSnapshot().volume).toBe(100);
    expect(oscillators).toHaveLength(1);
  });

  it("applies another tab's zero volume immediately and retains muted state on volume updates", () => {
    const { gains } = audioMock();
    const { sounds, click } = mount();
    click(gesture(document.querySelector("button")!));
    localStorage.setItem(interactionSoundsVolumeKey, "0");
    window.dispatchEvent(
      new StorageEvent("storage", { key: interactionSoundsVolumeKey }),
    );
    expect(sounds.getSnapshot().volume).toBe(0);
    expect(gains[0].disconnect).toHaveBeenCalledOnce();
    sounds.setEnabled(false, new Event("change"));
    sounds.setVolume(60);
    expect(sounds.getSnapshot().enabled).toBe(false);
  });

  it("synchronizes another tab's mute without playing a sound", () => {
    const { audio, oscillators, gains } = audioMock();
    const { sounds, click } = mount();
    click(gesture(document.querySelector("button")!));
    localStorage.setItem(interactionSoundsKey, "off");
    window.dispatchEvent(
      new StorageEvent("storage", { key: interactionSoundsKey }),
    );
    expect(sounds.getSnapshot().enabled).toBe(false);
    expect(gains[0].disconnect).toHaveBeenCalledOnce();
    expect(audio.close).toHaveBeenCalledOnce();
    localStorage.setItem(interactionSoundsKey, "on");
    window.dispatchEvent(
      new StorageEvent("storage", { key: interactionSoundsKey }),
    );
    expect(sounds.getSnapshot().enabled).toBe(true);
    expect(oscillators).toHaveLength(1);
  });

  it.each(["blur", "pagehide", "visibilitychange"])(
    "disconnects synchronously on %s and never autoplays on return",
    (type) => {
      const { audio, gains, oscillators } = audioMock();
      const { click } = mount();
      const event = gesture(document.querySelector("button")!);
      click(event);
      if (type === "visibilitychange") {
        vi.spyOn(document, "hidden", "get").mockReturnValue(true);
        document.dispatchEvent(new Event(type));
      } else window.dispatchEvent(new Event(type));
      expect(gains[0].disconnect).toHaveBeenCalledOnce();
      expect(audio.close).toHaveBeenCalledOnce();
      time = 200;
      click(event);
      expect(oscillators).toHaveLength(1);
      vi.spyOn(document, "hidden", "get").mockReturnValue(false);
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("pageshow"));
      expect(oscillators).toHaveLength(1);
      click(event);
      expect(oscillators).toHaveLength(2);
    },
  );

  it("resumes only from the gesture and does not schedule until the context is running", async () => {
    const { audio, oscillators } = audioMock("suspended");
    const { click } = mount();
    click(gesture(document.querySelector("button")!));
    expect(audio.resume).toHaveBeenCalledOnce();
    expect(oscillators).toHaveLength(0);
    await Promise.resolve();
    expect(oscillators).toHaveLength(1);
  });

  it.each(["mute", "leave", "unmount", "delay"])(
    "drops pending resumed audio after %s",
    async (reason) => {
      const { audio, oscillators } = audioMock("suspended");
      let resume!: () => void;
      audio.resume.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resume = resolve;
          }),
      );
      const { click, sounds } = mount();
      const event = gesture(document.querySelector("button")!);
      click(event);
      if (reason === "mute") sounds.setEnabled(false, event);
      if (reason === "leave") window.dispatchEvent(new Event("blur"));
      if (reason === "unmount") {
        dispose!();
        dispose = undefined;
      }
      if (reason === "delay") time = 500;
      audio.state = "running";
      resume();
      await Promise.resolve();
      expect(oscillators).toHaveLength(0);
    },
  );

  it("handles unavailable Web Audio and failed construction without interrupting actions", () => {
    vi.stubGlobal("AudioContext", undefined);
    const { sounds, click } = mount();
    const event = gesture(document.querySelector("button")!);
    expect(() => click(event)).not.toThrow();
    expect(sounds.getSnapshot().availability).toBe("unavailable");
    vi.stubGlobal(
      "AudioContext",
      vi.fn(function () {
        throw new DOMException("Unavailable");
      }),
    );
    time = 200;
    expect(() => click(event)).not.toThrow();
    expect(sounds.getSnapshot().availability).toBe("blocked");
  });

  it.each(["throw", "reject"])(
    "reports a %s from closing audio while preserving synchronous mute",
    async (failure) => {
      const { audio, gains } = audioMock();
      const error = new DOMException(
        "Audio device unavailable",
        "InvalidStateError",
      );
      if (failure === "throw")
        audio.close.mockImplementation(() => {
          throw error;
        });
      else audio.close.mockRejectedValue(error);
      const { sounds, click } = mount();
      click(gesture(document.querySelector("button")!));
      expect(sounds.getSnapshot().availability).toBe("ready");
      sounds.setEnabled(false, new Event("change"));
      expect(gains[0].disconnect).toHaveBeenCalledOnce();
      expect(sounds.getSnapshot().enabled).toBe(false);
      await Promise.resolve();
      expect(sounds.getSnapshot().availability).toBe("blocked");
    },
  );

  it("handles rejected resume and close promises without unhandled rejections", async () => {
    const { audio, oscillators } = audioMock("suspended");
    audio.resume.mockRejectedValue(
      new DOMException("Blocked", "NotAllowedError"),
    );
    audio.close.mockRejectedValue(
      new DOMException("Closed", "InvalidStateError"),
    );
    const { sounds, click } = mount();
    click(gesture(document.querySelector("button")!));
    await Promise.resolve();
    expect(sounds.getSnapshot().availability).toBe("blocked");
    expect(oscillators).toHaveLength(0);
    expect(() => sounds.setEnabled(false, new Event("change"))).not.toThrow();
    await Promise.resolve();
  });

  it("keeps mute working in memory when storage access fails and reports the limitation", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota");
    });
    const { constructor } = audioMock();
    const { sounds, click } = mount();
    expect(sounds.getSnapshot().storageAvailable).toBe(false);
    sounds.setEnabled(false, new Event("change"));
    click(gesture(document.querySelector("button")!));
    expect(sounds.getSnapshot().enabled).toBe(false);
    expect(constructor).not.toHaveBeenCalled();
  });

  it("cleans up its exact listeners, audio nodes and context on unmount", () => {
    const removeDocument = vi.spyOn(document, "removeEventListener");
    const removeWindow = vi.spyOn(window, "removeEventListener");
    const { audio, gains } = audioMock();
    const { click } = mount();
    click(gesture(document.querySelector("button")!));
    dispose!();
    dispose = undefined;
    expect(removeDocument).toHaveBeenCalledWith(
      "click",
      expect.any(Function),
      true,
    );
    expect(removeDocument).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
    for (const type of ["blur", "pagehide", "focus", "pageshow", "storage"]) {
      expect(removeWindow).toHaveBeenCalledWith(type, expect.any(Function));
    }
    expect(gains[0].disconnect).toHaveBeenCalledOnce();
    expect(audio.close).toHaveBeenCalledOnce();
    time = 200;
    click(gesture(document.querySelector("button")!));
    expect(audio.createOscillator).toHaveBeenCalledOnce();
  });
});
