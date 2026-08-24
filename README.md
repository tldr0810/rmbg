# Atelier — AI Background Remover

Atelier is a focused image background-removal studio powered by Manyfold AI and Cloudflare
Workers.

## What it does

1. Upload an image.
2. Remove the background with AI.
3. Refine the result in Studio.
4. Download a transparent PNG or a finished composition.

## Features

- AI-powered background removal for portraits, products, and everyday images.
- Studio controls for backgrounds, colour, shadows, scale, and positioning.
- Before-and-after comparison slider.
- Session history stored in the current browser for 24 hours.
- PNG export with the applied Studio adjustments.
- English-only interface with a clean, white Atelier design.

## Tech stack

- React and Vite
- Hono on Cloudflare Workers
- Cloudflare R2 for image processing storage
- Manyfold AI agents for background removal

## Development

```bash
npm install
npm run dev
```

Run the checks before opening a pull request:

```bash
npm test
npm run check
```

## Deployment

Configure the Cloudflare Worker and its bindings in `wrangler.jsonc`, then deploy with:

```bash
npm run deploy
```

Use Cloudflare Secrets for values such as `ADMIN_PASSWORD`, `CONFIG_ENCRYPTION_KEY`, and
`GEMINI_API_KEY`. Never commit secret values to the repository.

## Licence

This project is released under the MIT Licence. See [LICENSE](LICENSE).
