# Dennis Koshta — portfolio

Public portfolio at **https://denniskoshta.com**. Static HTML, local fonts, project screenshots and a profile photograph, and small browser scripts. There is no frontend framework, application database, analytics SDK, or visitor account system.

## Run locally

Requires Node.js 22 or later.

```bash
npm ci
npm run build
npm run dev
```

Open `http://localhost:4173`. `PORT` can select another local port. Run the build again after content or source changes; the preview server serves the current `dist/` files.

After changing the profile photo, rebuild and start the preview server, run `node scripts/render-social.mjs`, then rebuild again to include the updated link-preview image. The renderer accepts the same browser executable and base URL overrides as the browser checks.

## Content and emphasis

- `content/site.json`: homepage introduction, featured project order, section selections, contact links, and canonical origin.
- `content/core-projects.json`: Upbringing, Cognanimus, BusyCoq, and curiosity/satisfaction research.
- `content/supporting-projects.json`: AI tools, commercial products, and selected earlier work.
- `content/studio-projects.json`: the twelve Studio projects.
- `content/notes.json`: the two technical essays.
- `content/profile.json`: verified biography, public contact details, experience, and collaboration disclosure.
- `public/evidence/`: curated source-backed experimental and implementation summaries. Preserve observation dates, source references, conditions, and limitations when updating these files.
- `public/assets/studio/`: real screenshots of the public Studio applications.
- `public/assets/products/`: actual product screenshots using demonstration data.
- `scripts/build.mjs`: page templates, workflow illustrations, and the intervention chart generated from the public evidence summary.
- `styles/site.css`: readable responsive and print styles, with shared color and type tokens. The build minifies this into `dist/assets/site.css`.
- `public/assets/site.js`: filtering, accessible navigation, copy actions, and the verifier interface.
- `public/assets/verifier.js`: exact rational arithmetic for the illustrative task.

Project slugs produce stable `/work/<slug>/` URLs. Change `featured` and the other selection arrays to adjust the emphasis without forking the site. Keep category, domain, maturity, and contribution independent. Research, products, tools, and Studio entries remain available from the complete catalog.

Each project record contains a title, summary, type, status, domains, tools, contribution, sections, source links, limitations, related projects, and an evidence snapshot date. Outcome entries use `{ "value": "…", "label": "…" }`. Project cards do not display dates; source artifacts preserve their real provenance. Articles use their actual `publishedAt` date. An optional `primaryLink` selects a visitor-facing entry point; raw JSON/CSV evidence stays in the source links. Entries with private source should never use inaccessible private repositories as visitor CTAs.

The project intentionally excludes Rootspan, the homework collections, membership-only repositories, and infrastructure as standalone portfolio entries. Studio helper services belong in their parent projects. Commercial projects are described through the customer workflow rather than the original income motivation.

## Verification

```bash
npm test
npm run check
npx playwright install chromium
npm run dev
# In another terminal:
npm run test:browser
```

`npm test` exercises the arithmetic verifier's semantic boundary, malformed inputs, resource limits, and exact fraction handling. `npm run check` validates content, evidence links, local routes/assets/anchors, metadata, duplicate identifiers, and accidental private-path/credential patterns. The browser check covers desktop/mobile pages, WCAG A/AA automated rules, search/filter state, keyboard navigation, the verifier, images, and the 404 route. It writes its report and screenshots to the ignored `research/qa/` directory.

The browser suite accepts `TEST_BASE_URL` and `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. A minimal Linux/WSL installation may also need Playwright's documented browser libraries. Install system dependencies or supply a previously prepared library path through `LD_LIBRARY_PATH`; do not hard-code another machine's cache into the project.

Application demos linked from this portfolio have their own maturity, operating constraints, and external dependencies. Portfolio checks do not certify every application workflow or rerun the underlying training experiments.

## Publication

The Site identity and static output directory are tracked in `.openai/hosting.json`. The Sites workflow owns the source remote, commit, archive, and deployment. Keep the project ID unchanged. A deployment packages `dist/` and the hosting manifest from the exact pushed commit. Runtime credentials must never be written into this repository.

For future updates, build, check, and visually inspect the affected routes; use the Sites source workflow with a fresh short-lived credential; save and deploy the resulting archive. Preserve public access and the existing custom domains. DNS is managed through the owner's Cloudflare account. The source repository is private; publication contains only the generated static site and selected public evidence/assets.

## Attribution and design

The site uses DM Sans, with IBM Plex Mono for code, served locally with their SIL Open Font License files under `public/assets/fonts/`. The portrait is the headshot Dennis supplied directly for this portfolio. Studio and product images are screenshots of the actual applications; product screenshots use demonstration data and say so. The Cognanimus workflow is labeled as an illustration. The Curiosity chart is built from `public/evidence/satisfaction-screen-summary.json`, not decorative sample data. The small arithmetic example is an illustrative task, distinct from the historical Upbringing grader incident.

Codex and Claude Code contributed to the body of work in the ways described on individual project pages. This portfolio was authored and implemented with Codex. Preserve those distinctions, upstream credit, and the recorded negative findings when editing the site.
