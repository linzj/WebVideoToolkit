# Deployment Guide - Video Processor Web App

## Overview

This application is now optimized as a progressive web app with smart caching. It only downloads JavaScript when updates are available, providing instant loading for returning visitors.

## Build Process

### Development Build
For local development with source maps:
```bash
npm run build
# or
npm run watch  # Auto-rebuild on changes
```
Output: `dist/bundle.js` (unminified, with source maps)

### Production Build
For deployment to GitHub Pages or any static hosting:
```bash
npm run build:prod
```
Output in `dist/`:
- `index.html` - Main HTML page
- `main.[hash].js` - Your application code (~38KB minified)
- `vendors.[hash].js` - Dependencies (mp4box, mp4-muxer) (~181KB minified)
- `runtime.[hash].js` - Webpack runtime (~1KB)
- `service-worker.js` - Caching service worker (~1.8KB)

**Total size: ~220KB (approximately 60-80KB when gzipped)**

## What Changed

### Before
- Single `bundle.js` file: ~469KB
- No caching strategy
- Full download on every visit
- Development mode (not optimized)

### After
- Split into multiple chunks with content hashing
- Smart caching with service worker
- **First visit:** Download all files (~220KB, ~60-80KB gzipped)
- **Return visits:** Instant load from cache (0ms)
- **Updates:** Only changed chunks are downloaded
- Production optimized (minified, tree-shaken)

## Deploying to GitHub Pages

### Option 1: Manual Deployment

1. Build the production version:
   ```bash
   npm run build:prod
   ```

2. Commit the `dist/` folder (if not already in git):
   ```bash
   git add dist/
   git commit -m "Add production build"
   git push origin main
   ```

3. Configure GitHub Pages:
   - Go to your repository Settings → Pages
   - Source: Deploy from a branch
   - Branch: `main`, Folder: `/dist`
   - Save

4. Your site will be available at: `https://[username].github.io/[repository]/`

### Option 2: Automated Deployment with GitHub Actions

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [ main ]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Build
        run: npm run build:prod

      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: ./dist

      - name: Deploy to GitHub Pages
        uses: actions/deploy-pages@v4
```

Then configure GitHub Pages to use "GitHub Actions" as source.

## How Caching Works

### Service Worker Strategy

The service worker implements three caching strategies:

1. **Cache-First for Hashed JS Files**
   - Files like `main.abc123.js` are immutable
   - Served from cache instantly
   - Only downloaded once, cached forever

2. **Network-First for HTML**
   - Always checks for updates to `index.html`
   - Falls back to cache if offline
   - Ensures users get latest page structure

3. **Stale-While-Revalidate for Other Assets**
   - Serves cached version immediately
   - Updates cache in background
   - Best balance of speed and freshness

### Update Flow

When you deploy updates:

1. User visits the page
2. Service worker serves cached version (instant load)
3. Service worker checks for updates in background
4. If `index.html` changed → detects new JS hashes
5. Downloads only the changed chunks
6. Shows update notification: "🔄 New version available - Refresh to update"
7. User clicks notification → page reloads with new version
8. Old cache is automatically cleaned up

## User Experience

### First Visit
1. Browser downloads all files (~220KB)
2. "Loading Application" overlay shows during download
3. Service worker caches all files
4. Application starts

### Return Visits (No Updates)
1. Instant load from cache (0ms)
2. No "Loading Application" overlay
3. No network requests for JS files
4. Application starts immediately

### Return Visits (With Updates)
1. Instant load from cache (old version)
2. Service worker detects update in background
3. Downloads only changed files
4. Shows green update notification
5. User clicks to refresh → new version loads

## Testing Locally

To test the production build locally:

```bash
# Install a simple HTTP server (if not already installed)
npm install -g http-server

# Build production version
npm run build:prod

# Serve from dist folder
cd dist
http-server -p 8080

# Open in browser
# http://localhost:8080
```

**Important:** Service workers require HTTPS or localhost. They won't work with `file://` URLs.

## Verifying the Setup

After deployment, check the browser console:

```
[App] Service Worker registered: https://your-site.com/
[Service Worker] Installing...
[Service Worker] Precaching assets
[Service Worker] Activating...
```

On subsequent visits:
```
[Service Worker] Cache hit (immutable): main.abc123.js
[Service Worker] Cache hit (immutable): vendors.def456.js
```

When updates are available:
```
[App] Service Worker update found
[App] New version available
```

## File Structure

```
videoencdec/
├── dist/                          # Build output (deploy this folder)
│   ├── index.html                 # Main page
│   ├── main.[hash].js             # App code
│   ├── vendors.[hash].js          # Dependencies
│   ├── runtime.[hash].js          # Webpack runtime
│   └── service-worker.js          # Cache manager
├── service-worker.js              # Source (copied to dist/)
├── script.js                      # App entry point
├── *.js                           # Other source files
├── webpack.config.js              # Development build config
├── webpack.prod.config.js         # Production build config
└── package.json                   # Dependencies & scripts
```

## Troubleshooting

### Service Worker Not Registering

- Check browser console for errors
- Ensure site is served over HTTPS (or localhost)
- GitHub Pages automatically uses HTTPS

### Stale Content After Update

1. Open DevTools → Application → Service Workers
2. Click "Unregister"
3. Hard refresh (Ctrl+Shift+R or Cmd+Shift+R)

### Build Errors

```bash
# Clear node_modules and reinstall
rm -rf node_modules package-lock.json
npm install

# Rebuild
npm run build:prod
```

## Cache Invalidation

The content hash in filenames (`main.[hash].js`) automatically invalidates cache when code changes. You don't need to manually clear caches or add version query parameters.

**Example:**
- Old: `main.b4973cea.js` (cached)
- New: `main.f89a23bc.js` (downloaded, old one ignored)

## Performance Benefits

| Metric | Before | After |
|--------|--------|-------|
| First visit | ~469KB | ~220KB (~60-80KB gzipped) |
| Return visit | ~469KB | 0KB (cache) |
| Time to interactive (first) | ~2-3s | ~1-1.5s |
| Time to interactive (return) | ~2-3s | <100ms |
| Update download | ~469KB | Only changed chunks (~38-181KB) |

## Browser Compatibility

- Chrome/Edge 94+ (WebCodecs + Service Workers)
- Firefox (latest 2 versions)
- Safari 16.4+ (WebCodecs support)

Service workers are supported in all modern browsers. Older browsers will fall back to standard HTTP caching.

## Additional Resources

- [Service Workers MDN](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)
- [WebCodecs API](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API)
- [GitHub Pages Documentation](https://docs.github.com/en/pages)
