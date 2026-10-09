# Recognition benchmark

Run locally, with the existing account-mode environment:

```powershell
npm run benchmark:recognition -- --readonly --verify-unchanged
```

For a local development account configuration, set `$env:NODE_ENV='development'`
first (production retains its normal stricter account configuration).

Optional: `--holdout-fraction 0.3` (default). No package installation, network,
finance-file export, job enqueueing, or financial update is performed. Output is
aggregate JSON: account ordinals/counts, not account IDs, names, statements,
amounts, or error details. Native SQLite may print its own experimental warning.
`--readonly` requires an existing, current schema. Without it, native
`AccountDatabase` initialization may migrate schema like other operator scripts;
subsequent access is query-only. `--verify-unchanged` compares finance content,
revisions, and timestamps in memory; its private fingerprint is never emitted.
Concurrent finance changes cause verification failure. Accounts are evaluated
sequentially; snapshots over 20 MiB and catalogs over 10,000 merchants / 40,000
aliases are rejected. Only the database's `merchants` table supplies the catalog.

Add `--require-target` for an explicit quality gate. Exit code 2 and
`status: "target-not-supported"` mean the 99% goal is unproven or unmet, not
successful recognition. Evaluation/configuration failures return 1.

## Protocol

- Deduplicate ledger/fixed-receipt booking copies by logical transaction ID.
  Conflicting human labels or source facts exclude the entire logical row and
  are reported. Receipt wrapper categories are not labels.
- Category truth requires `manualCategory`, or `reviewed && categoryOverride`,
  and a non-`Prüfen` category. Automatic assignments, override alone, a lock alone,
  and `requires_manual_review=false` are not truth.
- Merchant truth requires an explicit manual canonical alias without inherited
  `merchantId`/`merchantMatch`. A category review does **not** confirm an automatic
  merchant identity. These conservative criteria may miss genuine confirmations;
  availability is reported rather than invented.
- Inputs are rebuilt from source fields only. Original `rawDescription`, when
  available, replaces potentially recovered display text; raw details, date/time,
  bank, amount and bank-origin category remain. Merchant identity, review/lock,
  category, fixed-cost and planning choices are removed or neutralized. No source
  text is reconstructed from a label. If historic display text was rewritten and
  the original was never retained, its source provenance cannot be verified.
- Chronological training uses earlier **whole booking dates**, not random rows.
  Only confirmed training categories/aliases teach rules; original account rules
  are always ignored, since their provenance may include holdout labels.
  Refunds do not teach spending rules; conflicting training choices abstain.
  No same-date/future choice trains a temporal holdout row.
- Future repeats are realistic and allowed. `temporalUnseenDescriptors` separately
  reports future source keys absent from all training. `descriptorGroupHoldout`
  removes every occurrence of selected source-key groups from training. Groups
  are bank-scoped normalized source descriptors (branch/reference/date variants
  collapse), **not** merchant identities; this is not
  proof of generalization to entirely unseen merchants. Group selection follows
  first source observation, never correctness. This separate group partition is
  not chronological: its training can include later dates, so it is a
  descriptor-generalization diagnostic, not a future-deployment estimate.
  A single date has no temporal
  training and sets `temporalAvailable=false`.
- Transfers/income are excluded; positive credits require source refund evidence
  or a confirmed refund category. Refund categories are scored against human truth.
  Unresolved providers, fuzzy/ambiguous and unknown merchants must remain open.

## Reading results / comparing implementations

`evaluateRecognitionBenchmark(state, index, { enrich?, holdoutFraction? })` returns
only aggregate counts. `aggregateRecognitionBenchmarks(results)` pools counts,
not percentages. Run baseline and changed enrichers against the **same unchanged
manually labeled snapshots, catalog, fraction and benchmark version**. Do not
benchmark newly backfilled output as new ground truth. No benchmark runs modify
those snapshots.

Automatic coverage is complete safe merchant+category assignments / eligible
holdout rows; abstentions count against coverage, not precision. Merchant/category
precision have separate human-labeled denominators. Joint precision scores
complete automatic predictions with both labels; joint correctness divides
correct automatic predictions by **all** jointly labeled rows, including reviews.
`unlabeledAutomatic` warns that such predictions cannot establish correctness.
Missing samples produce `null`, not 100%.

All rates include two-sided 95% Wilson intervals. Repeats are correlated:
descriptor-group correctness conservatively requires every labeled row in a
group to be automatically correct, and reports a separate group interval.
Even independent perfect decisions need at least 381 samples for a 99% Wilson
lower bound. `target99` requires coverage, both precisions, joint precision,
joint correctness **and** descriptor-group correctness lower bounds ≥99%.
It can only support the **labeled holdout**, never an unlabeled population-wide
99% claim. If any required denominator has fewer than 381 samples, the target
gate explicitly reports `insufficient-evidence`, even when point estimates are
below target; coverage and errors remain visible independently.
Merchant groups/accounts remain correlated, and non-random manual
review introduces selection bias. Small labeled histories or duplicated
synthetic variants cannot establish the requested target. Use representative
independently confirmed real-world labels before making deployment claims.
Pooled multi-account group counts are account-local diagnostic sums, not unique
independent descriptors. When more than one nonempty account contributes, the
aggregate target is withheld (`insufficient-evidence`); inspect each account's
own result. Empty accounts do not alter a single-account target.

Validation:

```powershell
npx vitest run src\lib\automation\recognition-benchmark.test.ts
npx eslint src\lib\automation\recognition-benchmark.ts src\lib\automation\recognition-benchmark.test.ts scripts\statement-recognition-benchmark.ts
npm run typecheck
```
