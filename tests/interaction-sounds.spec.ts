import { expect, test, type Page } from "@playwright/test";
import { createSeed } from "../src/lib/seed";
import {
  interactionSoundsKey,
  interactionSoundsVolumeKey,
} from "../src/lib/interaction-sounds";
import { focusTest } from "./helpers/real-focus";

type Automation = {
  method:
    | "setValueAtTime"
    | "linearRampToValueAtTime"
    | "exponentialRampToValueAtTime";
  value: number;
  time: number;
};
type Voice = {
  frequency: Automation[];
  envelope: Automation[];
  start: number;
  stop: number;
  wave: OscillatorType;
};

type AudioProbe = {
  contexts: number;
  starts: { state: AudioContextState; userActive: boolean }[];
  peaks: number[];
  closes: number;
  voices: Voice[];
};

async function instrumentAudio(page: Page) {
  await page.addInitScript((state) => {
    if (!localStorage.getItem("finanzdashboard.v1")) {
      localStorage.setItem("finanzdashboard.v1", JSON.stringify(state));
    }
    const probe: AudioProbe = {
      contexts: 0,
      starts: [],
      peaks: [],
      closes: 0,
      voices: [],
    };
    const record = (parameter: AudioParam, automation: Automation[]) => {
      for (const method of [
        "setValueAtTime",
        "linearRampToValueAtTime",
        "exponentialRampToValueAtTime",
      ] as const) {
        const original = parameter[method].bind(parameter);
        parameter[method] = (value, time) => {
          automation.push({ method, value, time });
          return original(value, time);
        };
      }
    };
    Object.assign(window, { __interactionAudio: probe });
    const RealAudioContext = window.AudioContext;
    // Keep the real browser audio graph and autoplay policy; record, do not fake, playback.
    window.AudioContext = class extends RealAudioContext {
      constructor(...args: ConstructorParameters<typeof AudioContext>) {
        super(...args);
        probe.contexts++;
      }
      createOscillator() {
        const oscillator = super.createOscillator();
        const voice: Voice = {
          frequency: [],
          envelope: [],
          start: 0,
          stop: 0,
          wave: "sine",
        };
        probe.voices.push(voice);
        record(oscillator.frequency, voice.frequency);
        const start = oscillator.start.bind(oscillator);
        const stop = oscillator.stop.bind(oscillator);
        oscillator.start = (when?: number) => {
          voice.start = when ?? this.currentTime;
          voice.wave = oscillator.type;
          probe.starts.push({
            state: this.state,
            userActive: navigator.userActivation.isActive,
          });
          start(when);
        };
        oscillator.stop = (when?: number) => {
          if (when !== undefined) voice.stop = when;
          stop(when);
        };
        return oscillator;
      }
      createGain() {
        const gain = super.createGain();
        record(gain.gain, probe.voices[probe.voices.length - 1].envelope);
        const ramp = gain.gain.linearRampToValueAtTime.bind(gain.gain);
        gain.gain.linearRampToValueAtTime = (value, endTime) => {
          probe.peaks.push(value);
          return ramp(value, endTime);
        };
        return gain;
      }
      close() {
        probe.closes++;
        return super.close();
      }
    };
  }, createSeed());
}

async function probe(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { __interactionAudio: AudioProbe })
        .__interactionAudio,
  );
}

async function settings(page: Page, href = "/einstellungen") {
  await page.goto(href);
  await expect(
    page.getByText("Lokal gespeichert", { exact: true }),
  ).toHaveCount(1);
  const unlock = page.getByRole("button", {
    name: "Sicherheitsmodus deaktivieren",
    exact: true,
  });
  if (await unlock.isVisible()) await unlock.click();
  await expect(
    page.getByRole("switch", { name: "Interaktionsklänge" }),
  ).toBeVisible();
}

async function renderedWaveform(page: Page, index: number) {
  return page.evaluate(async (index) => {
    const voice = (window as unknown as { __interactionAudio: AudioProbe })
      .__interactionAudio.voices[index];
    const duration = voice.stop - voice.start;
    const rate = 48000;
    const offline = new OfflineAudioContext(
      1,
      Math.ceil((duration + 0.03) * rate),
      rate,
    );
    const oscillator = offline.createOscillator();
    const gain = offline.createGain();
    oscillator.type = voice.wave;
    for (const [parameter, automation] of [
      [oscillator.frequency, voice.frequency],
      [gain.gain, voice.envelope],
    ] as const) {
      for (const event of automation) {
        parameter[event.method](
          event.value,
          Math.max(0, event.time - voice.start),
        );
      }
    }
    oscillator.connect(gain);
    gain.connect(offline.destination);
    oscillator.start(0);
    oscillator.stop(duration);
    const data = (await offline.startRendering()).getChannelData(0);
    const active = data.subarray(0, Math.ceil(duration * rate));
    const rms = Math.sqrt(
      active.reduce((sum, sample) => sum + sample * sample, 0) / active.length,
    );
    const peak = active.reduce(
      (max, sample) => Math.max(max, Math.abs(sample)),
      0,
    );
    const tail = data
      .subarray(Math.ceil((duration + 0.005) * rate))
      .reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
    return { peak, rms, duration, tail };
  }, index);
}

async function count(page: Page, expected: number) {
  await expect
    .poll(async () => (await probe(page)).starts.length)
    .toBe(expected);
}

test("real clicks, keyboard activation and switches play quietly; hover, typing and disabled controls stay silent", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await instrumentAudio(page);
  await settings(page);
  expect((await probe(page)).contexts).toBe(0);
  const theme = page.getByRole("button", { name: "Farbschema wechseln" });
  await theme.hover();
  const balance = page.getByRole("spinbutton", { name: "TR Kontostand" });
  await balance.fill("-1");
  const disabled = page.getByRole("button", {
    name: "Trade Republic speichern",
  });
  await expect(disabled).toBeDisabled();
  await disabled.click({ force: true });
  await theme.evaluate((button: HTMLButtonElement) => button.click());
  expect((await probe(page)).contexts).toBe(0);

  await theme.click();
  await count(page, 1);
  await page.waitForTimeout(180);
  await theme.press("Enter");
  await count(page, 2);
  await page.waitForTimeout(180);
  await theme.press("Space");
  await count(page, 3);
  await page.waitForTimeout(180);
  await page.getByText("Bewegung reduzieren", { exact: true }).click();
  await count(page, 4);
  await page.waitForTimeout(180);
  await page.getByRole("link", { name: "Übersicht", exact: true }).click();
  await count(page, 5);
  await page.waitForTimeout(180);
  await theme.dblclick({ delay: 5 });
  await count(page, 6);
  const audio = await probe(page);
  expect(audio.contexts).toBe(1);
  expect(
    audio.starts.every(
      (start) => start.state === "running" && start.userActive,
    ),
  ).toBe(true);
  expect(audio.peaks.every((peak) => peak > 0 && peak <= 0.12)).toBe(true);
  expect(errors).toEqual([]);
});

test("mute is immediate and survives appearance discard, navigation and reload independently of financial data", async ({
  page,
}) => {
  await instrumentAudio(page);
  await settings(page);
  const before = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("finanzdashboard.v1")!),
  );
  await page.getByRole("radio", { name: "Blau", exact: true }).check();
  const played = (await probe(page)).starts.length;
  const toggle = page.getByRole("switch", { name: "Interaktionsklänge" });
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Alle Interaktionsklänge sind stumm." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Verwerfen", exact: true }).click();
  await page.getByRole("button", { name: "Farbschema wechseln" }).click();
  await count(page, played);
  expect((await probe(page)).closes).toBe(1);
  expect(
    await page.evaluate(
      (key) => localStorage.getItem(key),
      interactionSoundsKey,
    ),
  ).toBe("off");
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("finanzdashboard.v1")!),
    ),
  ).toEqual(before);

  await page.getByRole("link", { name: "Übersicht", exact: true }).click();
  await count(page, played);
  await settings(page);
  await expect(toggle).not.toBeChecked();
  expect((await probe(page)).contexts).toBe(0);
  await toggle.check();
  await count(page, 1);
  expect(
    await page.evaluate(
      (key) => localStorage.getItem(key),
      interactionSoundsKey,
    ),
  ).toBe("on");
  await expect(
    page.getByRole("button", { name: "Einstellungen speichern", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("finanzdashboard.v1")!),
    ),
  ).toEqual(before);
});

test("default audio renders a meaningful waveform, volume is adjustable, and slider changes remain silent", async ({
  page,
}) => {
  await instrumentAudio(page);
  await settings(page);
  const slider = page.getByRole("slider", {
    name: "Lautstärke der Interaktionsklänge",
  });
  const preview = page.getByRole("button", { name: "Klang testen" });
  await expect(slider).toHaveValue("60");
  await preview.click();
  await count(page, 1);
  const normal = await renderedWaveform(page, 0);
  expect(normal.peak).toBeGreaterThan(0.1);
  expect(normal.peak).toBeLessThanOrEqual(0.121);
  expect(normal.rms).toBeGreaterThan(0.025);
  expect(normal.rms).toBeLessThan(0.055);
  expect(normal.duration).toBeLessThan(0.12);
  expect(normal.tail).toBeLessThan(0.0000001);
  await slider.press("End");
  await expect(slider).toHaveValue("100");
  await count(page, 1);
  expect(
    await page.evaluate(
      (key) => localStorage.getItem(key),
      interactionSoundsVolumeKey,
    ),
  ).toBe("100");
  await page.waitForTimeout(180);
  await preview.click();
  await count(page, 2);
  const louder = await renderedWaveform(page, 1);
  expect(louder.peak).toBeGreaterThan(0.18);
  expect(louder.peak).toBeLessThanOrEqual(0.201);
  expect(louder.rms / normal.rms).toBeGreaterThan(1.6);
  expect(louder.rms / normal.rms).toBeLessThan(1.7);
  await slider.press("Home");
  await expect(slider).toHaveValue("0");
  await expect(preview).toBeDisabled();
  await count(page, 2);
  expect((await probe(page)).closes).toBe(1);
});

focusTest(
  "leaving closes existing audio and returning never starts audio automatically",
  async ({ focusContext, baseURL }) => {
    const page = await focusContext.newPage();
    await instrumentAudio(page);
    await page.bringToFront();
    await settings(page, new URL("/einstellungen", baseURL).href);
    await expect
      .poll(() => page.evaluate(() => document.hasFocus()))
      .toBe(true);
    const initial = await probe(page);
    await page.waitForTimeout(180);
    await page.getByRole("button", { name: "Farbschema wechseln" }).click();
    await count(page, initial.starts.length + 1);
    const playing = await probe(page);
    const other = await focusContext.newPage();
    await other.goto("about:blank");
    await other.bringToFront();
    await other.mouse.click(50, 50);
    await expect
      .poll(async () => (await probe(page)).closes)
      .toBe(playing.closes + 1);
    await page.bringToFront();
    await expect
      .poll(() => page.evaluate(() => document.hasFocus()))
      .toBe(true);
    await other.close();
    await count(page, playing.starts.length);
    expect((await probe(page)).contexts).toBe(playing.contexts);
    await page
      .getByRole("button", {
        name: "Sicherheitsmodus deaktivieren",
        exact: true,
      })
      .click();
    await count(page, playing.starts.length + 1);
    expect((await probe(page)).contexts).toBe(playing.contexts + 1);
  },
);
