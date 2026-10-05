// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  InteractionSoundsProvider,
  InteractionSoundsSetting,
} from "./interaction-sounds";
import {
  interactionSoundsKey,
  interactionSoundsVolumeKey,
} from "@/lib/interaction-sounds";

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("AudioContext", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount() {
  return render(
    <InteractionSoundsProvider>
      <InteractionSoundsSetting />
    </InteractionSoundsProvider>,
  );
}

it("offers an accessible, immediately persisted local switch without synthetic playback", () => {
  const { getByRole, getByText } = mount();
  const toggle = getByRole("switch", {
    name: "Interaktionsklänge",
  }) as HTMLInputElement;
  expect(toggle.checked).toBe(true);
  expect(getByText("Sofort wirksam · nur in diesem Browser.")).toBeTruthy();
  fireEvent.click(toggle);
  expect(toggle.checked).toBe(false);
  expect(localStorage.getItem(interactionSoundsKey)).toBe("off");
  expect(getByRole("status").textContent).toBe(
    "Stumm.",
  );
  fireEvent.click(toggle);
  expect(localStorage.getItem(interactionSoundsKey)).toBe("on");
  expect(window.AudioContext).not.toHaveBeenCalled();
});

it("restores a muted preference and reports unavailable audio transparently", () => {
  localStorage.setItem(interactionSoundsKey, "off");
  vi.stubGlobal("AudioContext", undefined);
  const { getByRole } = mount();
  expect((getByRole("switch") as HTMLInputElement).checked).toBe(false);
  expect(getByRole("status").textContent).toBe(
    "Dieser Browser unterstützt keine Interaktionsklänge.",
  );
});

it("keeps the switch usable and describes session-only preference on storage failure", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Quota");
  });
  const { getByRole } = mount();
  fireEvent.click(getByRole("switch"));
  expect((getByRole("switch") as HTMLInputElement).checked).toBe(false);
  expect(getByRole("status").textContent).toContain("nur bis zum Neuladen");
});

it("offers a silent accessible volume adjustment and an explicit test button", () => {
  const { getByRole, getByText } = mount();
  const slider = getByRole("slider", {
    name: "Lautstärke der Interaktionsklänge",
  }) as HTMLInputElement;
  const preview = getByRole("button", {
    name: "Klang testen",
  }) as HTMLButtonElement;
  expect(slider.value).toBe("60");
  expect(preview.disabled).toBe(false);
  fireEvent.change(slider, { target: { value: "80" } });
  expect(getByText("80 %")).toBeTruthy();
  expect(localStorage.getItem(interactionSoundsVolumeKey)).toBe("80");
  fireEvent.click(preview);
  expect(window.AudioContext).not.toHaveBeenCalled();
  fireEvent.change(slider, { target: { value: "0" } });
  expect(slider.getAttribute("aria-valuetext")).toBe("0 Prozent – stumm");
  expect(preview.disabled).toBe(true);
  expect(getByRole("status").textContent).toBe(
    "Stumm.",
  );
  fireEvent.click(getByRole("switch"));
  expect(slider.disabled).toBe(true);
  expect(preview.disabled).toBe(true);
});
