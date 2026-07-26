# Universal Claimer — Session Exporter (browser extension)

A tiny, open-source browser extension that exports your **logged-in session cookies** so you can
connect an account in your self-hosted [Universal Claimer](../README.md) via **Session import** —
without a third-party cookie exporter.

Works in **Chrome** and **Firefox** (Manifest V3).

## Why this exists

Some services (e.g. Twitch) may refuse the instance-controlled browser used by *assisted login*.
Session import is the reliable fallback: log in with your normal browser, export the session, and
Universal Claimer drives the automation in its stealth browser with those cookies (cookies are not
bound to the User-Agent).

## Privacy & safety

- **100% local.** The extension never makes a network request — your cookies never leave your
  machine. It only reads them and hands them to *you* (clipboard / file download).
- **Scoped permissions.** `cookies` access is limited to the supported service domains
  (`twitch.tv`, `epicgames.com`, `microsoft.com`, `live.com`, `bing.com`) — see `manifest.json`.
- **Open source & unobfuscated.** Every line runs as written here; nothing is minified or bundled.

> The exported `cookies.txt` contains a full session (equivalent to a password). Only paste it into
> your own Universal Claimer instance; don't share the file.

## Install (unpacked — no store needed)

Because you self-host, you can load the extension straight from this folder, so what runs *is* this
source:

- **Chrome / Edge**: open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**,
  and select this `extension/` folder.
- **Firefox**: open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**, and
  select `extension/manifest.json`.

## Use

1. Log in to the service (e.g. `twitch.tv`) in this browser.
2. Click the extension icon → pick the service → **Copy cookies.txt**.
3. In Universal Claimer, go to `/connect/<service>`, fill any required config (e.g. the Twitch
   channel), choose **Session import**, paste, and **Connect account**.

## Publishing (source == store binary)

The store builds are produced **only** by CI from this repository (no manual uploads), so the
published artifact provably matches this source — anyone can audit the workflow. Firefox AMO also
keeps and reviews the source. See `.github/workflows/publish-extension.yml` (added with the CI
phase); it requires store API credentials configured as repository secrets.

## Roadmap

- **Direct send**: a "Connect to my instance" button that pushes the session to your Universal
  Claimer instance in one click (instance URL + token), in addition to copy/download.

## Development

`extension/cookies.js` holds the pure logic (Netscape serialization, service resolution) and is
unit-tested from the repo root: `pnpm exec vitest run extension/cookies.test.ts`.
