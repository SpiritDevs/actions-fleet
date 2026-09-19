# Actions Fleet dashboard

React + Vite dashboard for the real fleet relay. There is no demo data or client-side authentication bypass. The configured operator signs in with GitHub; the relay enforces authorization and repository admission.

From the repository root, run `npm install`, then `npm run dev:dashboard`. Vite proxies `/api/*` and `/auth/*` to `http://127.0.0.1:8787`. Configure the relay's `DASHBOARD_ORIGIN` and GitHub OAuth callback for the exact dashboard origin (`http://localhost:5173` and `http://127.0.0.1:5173` are different origins). In production, use the root Vercel configuration and the hosted relay; preserve cookies and the browser's Origin header through the proxy.

The dashboard reads `/api/session` before requesting protected data. Missing App configuration shows setup instructions; an unavailable relay shows a retryable error. Connection installation uses GitHub's normal App flow. Enrollment tokens are shown only in their current dialog and are never stored in browser persistence, URLs, or console logs.

The overview starts with the newest 500 jobs and 100 audit events. **Load older** follows the relay's opaque keyset cursors through retained history; filters apply to the loaded records. Job deep links fetch individual retained jobs even when they are outside the overview window.

Live connections use one-use tickets from `/api/live-ticket`, then connect directly to the returned WebSocket URL. Every reconnect retrieves retained console history using the last HTTP-confirmed cursor. Live and replayed lines are deduplicated by job sequence. The screen holds at most 3,000 lines; its download exports the visible window including active filters. The GitHub job link provides access to GitHub's retained full logs. On connection loss, metadata polls every 20 seconds and console history every 10 seconds; the UI labels the loss of live updates.

Controls show their GitHub scope before execution. Cancellation affects the entire workflow run, and job reruns include dependent jobs. An accepted request is not presented as a completed state change. Shared mode is described as best effort; displayed metrics refer to the whole machine.

Failed jobs offer **Copy AI fix prompt**. The button retrieves failure-focused retained context beyond the visible console window and locally formats job details, failed steps, links, current machine inventory, and quoted log evidence into a prompt capped at 32 KiB. Coverage notes identify omitted or missing logs. If retrieval fails, the prompt explicitly falls back to the loaded console; if clipboard access is denied, a selectable text area provides the prompt. No AI API is called.

Validation: `npm run build --workspace @actions-fleet/dashboard`, `npm run typecheck --workspace @actions-fleet/dashboard`, and `npx vitest run apps/dashboard/src/model.test.ts apps/dashboard/src/fixPrompt.test.ts apps/dashboard/src/fixPromptClipboard.test.ts`. No production deployment or authenticated browser session is required to compile.
