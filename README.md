# Fetchfox 🦊

A download manager for Android/Termux in the spirit of **1DM** and **Free Download
Manager** — segmented downloads, pause/resume, torrents, and media-site support,
all running locally on your phone with a phone-native interface.

No root. No APK. No cloud account.

```
aria2c  (engine)    16 connections per file, resume, torrents, magnet
yt-dlp  (media)     YouTube, Instagram, TikTok, HLS/m3u8, 1000+ sites
node    (UI)        local web app + PWA, JSON-RPC bridge
```

## Install

Requires Termux (F-Droid) with:

```bash
pkg install nodejs aria2 yt-dlp ffmpeg termux-api
```

Clone, then:

```bash
cd fetchfox
./start.sh          # start in background
./start.sh open     # start and open the UI in your browser
./stop.sh           # stop everything
```

Open **http://127.0.0.1:8080**.

To get a real app icon: Chrome menu **⋮** → **Add to Home screen**. It launches
fullscreen, with its own icon and no address bar.

## Features

| Feature | Status |
|---|---|
| Up to 16 connections per file | ✅ |
| Pause / resume / cancel | ✅ |
| Queue (3 at a time, rest wait) | ✅ |
| Global speed limit | ✅ chips in UI |
| Resume after restart | ✅ session file |
| Torrent + magnet links | ✅ |
| Video/audio sites via yt-dlp | ✅ auto-detected |
| Playlist downloads | ✅ toggle in Options |
| Finished-file browser, play, delete | ✅ Files tab |
| Notification on completion | ✅ via termux-api |
| Media scanner (shows in Gallery) | ✅ via termux-api |
| Clipboard paste button | ✅ via termux-api |
| Installable PWA | ✅ |

## Where files go

```
~/storage/shared/Downloads/Fetchfox     (same as /sdcard/Downloads/Fetchfox)
```

Files are visible to the Files app, Gallery, VLC, etc. Change the `dir=` line in
`fetchfox.conf` and restart to move it somewhere else.

## Keeping downloads alive

Android suspends background apps. Do these once:

1. `./start.sh` already acquires a wake lock.
2. Phone Settings → Apps → **Termux** → Battery → **Unrestricted**
   (or disable battery optimization for Termux).
3. Keep the Termux notification visible while downloading.

Without step 2, Android may freeze the transfer when the screen is off.

## Limits (honest ones)

- **Cannot intercept links from other apps.** Registering as the system download
  handler needs a signed APK with an `INTENT` filter — not possible from Termux.
  Workaround: long-press a link → *Copy link* → tap **Paste** in Fetchfox.
- **Cannot replace the browser's downloader.** Same reason.
- **Pause on yt-dlp jobs** uses `SIGSTOP`, so the remote connection may time out
  and the job may need **Retry**.
- Localhost only. Nothing is exposed to the network (`127.0.0.1`).

## Project layout

```
server.mjs              backend: aria2 RPC bridge, yt-dlp jobs, file server
public/                 UI — index.html, app.js, style.css, sw.js, icons
scripts/make-icons.mjs  regenerates the PWA icons (fox mark, no dependencies)
start.sh / stop.sh      launchers
fetchfox.conf           engine config — generated on first run, editable
fetchfox.session        saved queue for resume-after-restart
fetchfox.log            runtime log
```

`fetchfox.conf`, `fetchfox.session` and `*.log` are gitignored — the config is
created on first run with paths correct for wherever you cloned it.

## Termux:Widget

Install **Termux:Widget** from F-Droid and run:

```bash
mkdir -p ~/.shortcuts
cat > ~/.shortcuts/Fetchfox.sh <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
cd "$HOME/fetchfox" && bash start.sh
termux-open-url "http://127.0.0.1:8080"
EOF
chmod +x ~/.shortcuts/Fetchfox.sh
```

Add the widget to your home screen and pick **Fetchfox** — one tap starts the
server and opens the UI.

## Troubleshooting

```bash
tail -f ~/fetchfox/fetchfox.log            # live logs
curl -s 127.0.0.1:8080/api/state | python3 -m json.tool
./stop.sh && ./start.sh                    # full restart
```

If the status dot says *engine offline*, aria2 died — check the log.

## Notes

Fetchfox is an independent project. It is not affiliated with 1DM, Free Download
Manager, aria2, or yt-dlp; those names are referenced only to describe what this
tool is similar to.
