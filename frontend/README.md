# frontend (fastapi-vite-shadcn)

React 19 + JavaScript on **Vite**, Tailwind CSS **v4** via `@tailwindcss/vite` (theme tokens live in
`src/index.css` under `@theme`; there is no `tailwind.config.js`/`postcss.config.js`), shadcn/ui (Radix),
react-router-dom, axios, TanStack Query (`QueryClientProvider` mounted in `src/index.js`, client in
`src/lib/queryClient.js`).

Same conventions as the classic `shadcn` (fastapi_react_mongo_shadcn) template: JSX lives in `.js` files (`src/index.js`,
`src/App.js`), the `@/*` alias maps to `src/*`, and the frontend reads
`REACT_APP_BACKEND_URL` from `frontend/.env` as the development proxy target.

For local setup, copy `frontend/.env.example` to `frontend/.env` and set the backend URL.
Copy `backend/.env.example` to `backend/.env` and replace its placeholders with your local
database connection and private credentials. Never commit the populated `.env` files.
During Vite development, API requests use the same-origin `/__api` path and are proxied to
`REACT_APP_BACKEND_URL`; this lets remote workspace previews reach the backend without the
browser trying to connect to its own `localhost`. Production builds use the same-origin `/api`
route, which the deployed host proxies to the backend; they do not embed a machine-local backend
URL in browser assets.

Company admins create/copy or disable the active company's secure customer order link from the
Orders page when the Global Owner has enabled its controls in Settings > Features. This visibility
setting applies to every company profile; hiding the controls does not revoke active links. The link
is a random, revocable capability URL, with its token in the URL fragment so
it is not sent in HTTP requests or referrer headers; only its hash and encrypted recovery
value are stored, and public form requests are rate limited. The form requires contact name, shop
name, phone, city, and at least one product. Submissions are size-validated and idempotent on retry.
Existing customers are matched by normalized phone first, then by a unique, high-confidence
similarity against the submitted contact or shop name. A new customer record is created only when
no likely match exists; ambiguous matches remain unlinked for staff review. Submitted data does not
overwrite existing customer contact records. The Orders list identifies link vs manual entry and
the match outcome; the order detail keeps the contact details submitted by the customer. If staff
link an unmatched order to a customer, that manual assignment is recorded. Public form analytics
and session replay are suppressed to avoid sending link tokens or submitted data to PostHog.

## Scripts

- `yarn start` / `yarn dev` — Vite dev server on port 3000 (supervisor runs `yarn start`)
- `yarn build` — production bundle into `build/`
- `yarn preview` — serve the production bundle locally

Hot reload is enabled via Vite HMR and polling, so edits made in the current Emergent workspace
are reflected in its preview. HMR does not fetch commits from GitHub: pushing a commit, changing
branches, or opening the preview in a new browser tab does not synchronize the workspace checkout.
Before testing a GitHub change in Emergent, use its repository/source-control sync to select
`editfoto391-del/AZIENDA-1-` on `feature/multicompany-erp`, then verify the checked-out commit
matches the commit on GitHub. A browser refresh reloads the current workspace only. Restart the
`frontend` supervisor program after syncing if the preview did not pick up the changed files, and
always after changing `.env` or `vite.config.mjs`, or after installing dependencies (`yarn add`,
never npm). The Vite development server sends `Cache-Control: no-store`; if the workspace commit
matches but the page still looks old, reload the browser without cache before investigating the
preview runtime.

Visual edits: the packaged `@emergentbase/visual-edits` plugin tags `.jsx`/`.tsx`; because this
template keeps JSX in `.js`, `vite.config.mjs` stamps the same `x-*` metadata on `src/**/*.js`
before compiling the JSX (dev server only; `DISABLE_VISUAL_EDITS=true` turns it off).
