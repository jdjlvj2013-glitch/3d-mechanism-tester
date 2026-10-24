# Deploying 3D Mechanism Tester

Fully static, offline-capable PWA. Parts load locally via the file picker; no server or uploads.
Built with relative paths (`base: './'`), so `dist/` works at a domain root or any subpath.

## Run locally
```bash
npm install
npm run dev        # dev server (http://localhost:5173)
npm run build      # outputs dist/
npm run preview    # serve the production build (service worker active here)
```
The service worker only registers on `https://` or `localhost`.

> Every hosted option below needs **your own account sign-in** (GitHub / Netlify / Cloudflare). Nothing has been deployed.

## GitHub Pages
1. Push the repo to GitHub (sign in to your account).
2. Settings → Pages → Source: **GitHub Actions**.
3. Add `.github/workflows/deploy.yml`:
```yaml
name: Deploy
on: { push: { branches: [main] } }
permissions: { contents: read, pages: write, id-token: write }
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: github-pages
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci && npm run build
      - uses: actions/upload-pages-artifact@v3
        with: { path: dist }
      - uses: actions/deploy-pages@v4
```
Served at `https://<user>.github.io/<repo>/` — relative base handles the subpath.

## Netlify
- UI: sign in → Add new site → Import from Git → build command `npm run build`, publish dir `dist`.
- Or CLI: `npx netlify-cli login` then `npx netlify-cli deploy --prod --dir=dist`.
- Or drag-and-drop `dist/` onto app.netlify.com/drop (still requires sign-in to keep the site).

## Cloudflare Pages
- UI: sign in → Workers & Pages → Create → Pages → Connect to Git → framework preset **Vite** (build `npm run build`, output `dist`).
- Or CLI: `npx wrangler login` then `npx wrangler pages deploy dist --project-name=3d-test-app`.

## Updates
`registerType: 'autoUpdate'`: after a redeploy, open clients pick up the new version on next load.
