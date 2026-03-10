# memento-mcp Local Operations

## Quick Flow

Initial setup once:

```powershell
npm run local:setup
```

Normal start:

```powershell
npm run local:start
```

- Shows the `Memento Status` window in the top-left.
- Starts Postgres, Redis, and `server.js` in the background.
- Health check: `http://127.0.0.1:57332/health`

Service-only start:

```powershell
npm run local:start:service
```

- Starts services without the overlay.

Normal stop:

```powershell
npm run local:stop
```

- Stops `server.js`, Redis, and Postgres.
- Closes the overlay too.

Service stop:

```powershell
npm run local:stop:service
```

- Current package behavior is the same as `local:stop`.

## Steady-State Expectations

- Only one `Memento Status` window should remain.
- Disposable helper shells should not remain after startup settles.
- Expected ports while running:
  - `55432` for Postgres
  - `6379` for Redis
  - `57332` for the memento HTTP server

## Advanced Commands

Keep the overlay open but stop services:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/stop_local_windows.ps1 -KeepOverlay
```

Open only the overlay again:

```powershell
npm run local:overlay:left
```
