<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Task checkpoints (user preference)

- After each completed implementation or redesign request, create one commit containing all changes for that request and push it to the configured upstream. Do not combine independent requests.
- Continuations such as "Continue", follow-up fixes, tests, and final acceptance belong to the same unfinished request. Commit only when the entire request is complete; do not split its implementation, individual files, fixes, or acceptance into separate commits.
- Run the relevant validations before declaring completion. Report failed checks or a failed push explicitly; never claim an unverified success.
- Do not create empty commits for questions, status checks, or continuations that introduce no file changes.
- Stage only changes belonging to the task. Keep unrelated user edits, secrets, ignored financial files, local browser data, and generated artifacts out of commits.
- Use normal pushes. Do not amend, rebase, or force-push published history unless explicitly requested.
- When backfilling commits, separate only verifiable task boundaries and explain missing historical snapshots. Do not invent earlier states or timestamps.
- In the final response, include the short commit ID, validation status, and push status.
