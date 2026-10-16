# Dennis Koshta — portfolio

Public portfolio at **https://denniskoshta.com**. Static HTML, system fonts, a small stylesheet, and browser JavaScript for project search and an optional application embed. No frontend framework, analytics, database, or visitor accounts.

## Run locally

Requires Node.js 22 or later.

```bash
npm ci
npm run build
npm run dev
```

Open `http://localhost:4173`. Set `PORT` to use a different port. Rebuild after source changes; the server serves `dist/`.

## Edit the site

- `content/site.json`: introductory paragraphs and the ordered `selected` projects on the homepage. Each selection has a project slug and a short description.
- `content/core-projects.json`, `content/supporting-projects.json`, `content/studio-projects.json`: the 28 project records.
- `content/notes.json`: technical articles, including their actual publication dates.
- `content/profile.json`: biography, experience, contribution disclosures, and the supplied headshot.
- `scripts/build.mjs`: readable static page templates.
- `styles/site.css`: responsive and print styles; minified into `dist/assets/site.css` at build time.
- `public/assets/site.js`: project filtering and loading/unloading the Signal Garden application.
- `public/evidence/` and `public/assets/supporting/`: source-backed experimental and implementation summaries. Preserve their conditions, dates, and limitations.
- `public/assets/studio/` and `public/assets/products/`: actual application screenshots. Product screenshots use demonstration data.

Project URLs remain `/work/<slug>/`. Project lists omit dates; articles and evidence retain their actual provenance. Private repositories should not become visitor-facing links. Content excludes Rootspan, homework collections, membership-only repositories, and infrastructure as standalone projects.

The homepage is deliberately selective. The complete project index and existing research, Studio, writing, and case-study URLs remain available. The research notes keep negative results, limitations, and attribution alongside positive findings.

## Interactive application

The Signal Garden panel embeds the real application hosted on GitHub Pages. It makes no application request before the visitor opens the panel. Closing the panel removes the iframe and stops its audio. An ordinary link to the full application remains available with or without JavaScript. The application is developed separately; portfolio checks do not certify every application workflow.

After replacing the headshot, rebuild and start the preview server, run `node scripts/render-social.mjs`, then rebuild again. This regenerates the link-preview card from HTML using the photo unchanged. The renderer accepts `TEST_BASE_URL` and `PLAYWRIGHT_CHROMIUM_EXECUTABLE`.

## Verification

```bash
npm run build
npm run check
npx playwright install chromium
npm run dev
# In another terminal:
npm run test:browser
```

The content check validates all project records, local routes/assets/anchors, metadata, duplicate identifiers, and accidental private-path/credential patterns. Browser checks cover all routes at desktop and mobile widths, automated WCAG A/AA rules, search and URL persistence, keyboard navigation, application loading/closing, and the 404 page. Reports and screenshots go to ignored `research/qa/`.

The browser suite accepts `TEST_BASE_URL` and `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. A minimal Linux/WSL environment may also need browser libraries through `LD_LIBRARY_PATH`. No machine-specific cache paths belong in the project.

## Previous design

The previous design is preserved in source commit `43372fe4763f8b101a49e7a0c97e8368f477f0ae` and hosted version 5. Separate source and built-site archives were also saved outside this checkout before the redesign. The removed arithmetic demo and its tests remain recoverable from that snapshot.

## Publication

`.openai/hosting.json` contains the existing Site identity and `dist/` output directory. The Sites workflow owns source synchronization, commits, archives, and deployment. Preserve the project ID, public audience, and custom domains. Build, check, and inspect changes before saving and deploying the matching archive. Never write runtime credentials into this repository.

## Attribution

The portrait was supplied directly by Dennis. Codex and Claude contributed to the projects in the ways described on their pages. This site was implemented with Codex. Preserve contribution distinctions, upstream credit, and the recorded negative findings when editing.
