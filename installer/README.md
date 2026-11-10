# Desktop app (macOS)

A no-code way to run the Financial Planner: download, drag to Applications, double-click.

## Contents

- [How it works](#how-it-works)
- [Layout](#layout)
- [Build it on your Mac](#build-it-on-your-mac)
- [Build downloads for a release](#build-downloads-for-a-release)
- [Icons](#icons)
- [Where things go on the user's Mac](#where-things-go-on-the-users-mac)

## How it works

`Financial Planner.app` is a thin bootstrapper (the same design as
[jupyter_bioacoustic's installer](https://github.com/SchmidtDSE/jupyter_bioacoustic/tree/main/installer)):

1. The app bundles a pinned **pixi** binary and a small **manifest** (`manifest/pixi.toml`).
2. **First launch** copies pixi to `~/Library/Application Support/FinancialPlanner/`, installs the
   environment from the manifest (Python + `financial-planner[desktop]` from PyPI; no git) with a
   "Setting up…" dialog, then starts the app. Later launches skip straight to step 3.
3. The app runs `python -m financial_planner.desktop`: a **menu-bar icon** that asks where the plan
   lives the first time (default `~/FinancialPlan`, a chosen folder, or the demo), starts the local
   server and opens the browser.

The menu-bar app is single-instance (launching again opens the browser on the running one),
and the server exits whenever the app does (Quit, force quit or crash).

## Layout

```
installer/
  manifest/pixi.toml              environment the app installs (financial-planner from PyPI)
  shared/bootstrap.sh             ensure pixi → ensure env → run the menu-bar app
  macos/app/Financial Planner.app template bundle (Info.plist + launch script)
  macos/assemble-app.sh           the one place that puts a bundle together
  macos/make-local-app.sh         build into /Applications for this Mac
  macos/make-dist.sh              build unsigned zips (Apple Silicon + Intel) for a release
  icon/financial-planner.svg      app icon source
  icon/tray.svg                   menu-bar icon source
  icon/make-icons.sh              → src/financial_planner/assets/AppIcon.icns, tray.png
```

The menu-bar app itself is `src/financial_planner/desktop.py` (tested in `tests/test_desktop.py`).

## Build it on your Mac

```bash
bash installer/macos/make-local-app.sh                # installs the latest PyPI release
FP_SOURCE=. bash installer/macos/make-local-app.sh    # installs this checkout instead
```

The app lands in `/Applications` (or `~/Applications` if that isn't writable; pass another folder
as an argument). It's ad-hoc signed, so it runs on the Mac that built it.

People who already have the code can also run `pixi run financial_plan launcher`, which writes a
small `Financial Planner.app` into `/Applications` that uses the current environment (no
separate install).

## Build downloads for a release

```bash
bash installer/macos/make-dist.sh
```

This produces `installer/dist/FinancialPlanner-macos-arm64.zip` (Apple Silicon) and
`FinancialPlanner-macos-x86_64.zip` (Intel), each bundling the matching pinned pixi. Attach both
to a GitHub release. The apps install `financial-planner` from PyPI (any 0.x version, newest
first), so publish the PyPI release before handing out apps that need its changes.

The apps are **unsigned**: the first time, people right-click the app → **Open** → **Open**.
Signing and notarizing need an Apple Developer account.

## Icons

Edit the SVGs, then `bash installer/icon/make-icons.sh` (uses `rsvg-convert` if installed, else
headless Google Chrome). The generated files are committed, so building the app doesn't need this.

## Where things go on the user's Mac

| What | Where |
|---|---|
| The app | `/Applications` or `~/Applications` |
| pixi, the environment, logs (`launch.log`, `desktop.log`, `server.log`) | `~/Library/Application Support/FinancialPlanner/` |
| Which plan to open | `~/.financial_planner.json` |
| The plan itself | wherever the person chose (default `~/FinancialPlan`) |

Uninstall: menu-bar icon › **Uninstall…** (or `financial_plan uninstall`), or quit the app and
delete it and `~/Library/Application Support/FinancialPlanner/`. Plans are never touched.

Updates: menu-bar icon › **Check for Updates…** compares the running version with PyPI, runs
`pixi clean cache --pypi` (a stale package index can keep the old version), `pixi update` and
`pixi install` on the app's environment, checks the installed version and relaunches the app
(`FP_APP_BUNDLE`, set by the launch script). If PyPI hasn't caught up yet, it says so and keeps
running the old version.
