# Music Complex for Windows

Music Complex is a Windows desktop music player for Plex libraries. It is built with Electron, React, and Vite, and focuses on fast library browsing, reliable queue control, local playback, and Chromecast playback from a dedicated desktop app.

## Features

- Sign in with Plex or connect directly to a Plex server
- Browse artists, albums, playlists, and tracks
- Search the current library view
- Play music locally on this computer
- Cast playback to Chromecast devices on the local network
- Manage the queue, including adding, removing, and reordering tracks
- Shuffle and repeat playback
- Match volume between tracks
- Light and dark themes
- Windows installer and portable executable builds

## Development

```powershell
npm install
npm run dev
```

## Test

```powershell
npm test -- --run
npm audit
```

## Build Installer

```powershell
npm run dist
```

Build output is written to `release/`.
