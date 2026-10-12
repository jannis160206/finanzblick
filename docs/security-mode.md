# Screen privacy

The security mode is a visual screen-privacy feature, not authentication,
encryption or a password lock. Financial data remains in the application and
DOM; blur must never replace server-side account authorization.

Settings > Sicherheitsmodus offers three browser-local activation preferences:

- **Automatisch** (default): leaving the tab or window masks financial data.
  Returning does not reveal it; unlock explicitly using the shield.
- **Nur manuell**: use the shield yourself. Tab/window changes do not activate it.
- **Deaktiviert**: removes the current mask and disables the shield.

Existing saved locks remain supported. Preferences synchronize between tabs,
while an automatically locked tab stays protected until explicitly unlocked.
A native file picker is not treated as leaving the application. Invalid or
unavailable browser storage fails closed, with an explicit error and retry.
No financial snapshot fields are changed or synchronized for this preference.

`FinancialData` marks amounts, charts, transaction rows, private names and
financial form regions. Locked regions retain their layout, use an immediate
10px blur, and are inert and excluded from assistive technology. Headings,
navigation and the privacy settings stay readable. Nested regions do not
accumulate blur. The dense payroll workspace preserves its visible page
heading and masks its data area without depending on payroll calculations.

The bootstrap and global CSS protect the initial render before hydration.
Sensitive portals and notifications remain hidden while locked. Financial
data is hidden rather than blurred when printing a locked page.
