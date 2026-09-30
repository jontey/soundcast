# Soundcast Frontend

Svelte 5 + Vite scaffold. No pages migrated yet.

## Install

```
npm install
```

## Develop

```
npm run dev
```

## Build

```
npm run build
```

Output goes to `../dist/frontend/` with one entry per page: `listener/`, `publisher/`, `studio/`, `admin/`.

## Status

This is an empty shell. Each entry renders its name and a note that migration has not started. Fastify still serves the old pages from `src/public/`. No WebSocket, no mediasoup import, no API fetch is wired up yet.
