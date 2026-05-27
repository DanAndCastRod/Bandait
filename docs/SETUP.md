# Bandait Setup Guide

## Hardware Requirements

### Leader (Desktop)
- **OS**: Windows 10/11 (64-bit), macOS 12+, or Linux
- **CPU**: Intel i5 / AMD Ryzen 5 or better (for multitrack recording)
- **RAM**: 8GB minimum, 16GB recommended
- **Audio Interface**: Behringer UMC-202HD or UMC-204HD (4 channels out, 2-4 channels in)
- **Network**: Wi-Fi adapter capable of hotspot mode, or dedicated router

### Followers (Mobile)
- **iOS**: Safari 15+ (PWA support)
- **Android**: Chrome 90+ (PWA support)
- **Any device**: Modern browser with Web Audio API and WebSocket support

---

## Installation

### Leader (Windows)

1. **Download** the latest installer from Releases.
2. **Install** Bandait Leader using the setup wizard.
3. **Install ASIO drivers** for your audio interface:
   - Behringer: Download from [Behringer website](https://www.behringer.com/product.html?modelCode=P0ASF)
   - Or use generic ASIO4ALL as fallback.
4. **Launch** Bandait Leader from Start Menu or Desktop.

### First Run

1. The app will create a local database (`bandait.db`) in your Documents folder.
2. **Google Cloud API Key** (optional, for AI features):
   - Set environment variable: `BANDAIT_GOOGLE_API_KEY=your_key_here`
   - Or store securely: Open terminal and run:
     ```bash
     python -m keyring set bandait google_api_key
     ```
3. **Audio Device Selection**: The app auto-detects your interface. If not found, check Windows Sound settings.

---

## Network Setup

### Option A: Leader as Wi-Fi Hotspot (Recommended for Gigs)

1. Open Windows Settings → Network & Internet → Mobile Hotspot.
2. Enable hotspot with a simple password.
3. Connect all follower phones to this hotspot.
4. Bandait Leader will show its IP and a QR code for easy connection.

### Option B: Shared Router (Rehearsal Space)

1. Ensure all devices are on the same LAN.
2. Leader shows its local IP (e.g., `192.168.1.15:4040`).
3. Followers scan QR or enter IP manually.

### Firewall

If followers cannot connect:
- Open Windows Defender Firewall → Allow app through firewall.
- Add `BandaitLeader.exe` for Private and Public networks.
- Or temporarily disable firewall for testing (not recommended for gigs).

---

## Audio Routing

### Behringer UMC-204HD (4 channels)

| Channel | Content | Destination |
|---------|---------|-------------|
| 1 | Mix (backing + click) | FOH / Main PA |
| 2 | Click only | Drummer in-ear |
| 3 | Backing track | Keyboardist in-ear |
| 4 | Click + cues | Bassist in-ear |

### Recording Setup

- Inputs 1-2: Vocals and guitar (or stereo mix from mixer)
- Inputs 3-4: Room mics or additional instruments
- Recording saves to `Documents/Bandait/Recordings/YYYY-MM-DD/`

---

## Follower PWA

### iOS (iPhone/iPad)

1. Open Safari and navigate to the Leader's URL (scan QR).
2. Tap **Share** → **Add to Home Screen**.
3. Launch from the home screen icon (full-screen, no browser chrome).

### Android

1. Open Chrome and navigate to the Leader's URL.
2. Tap menu → **Add to Home Screen**.
3. Launch from the home screen icon.

### Desktop Browser

1. Open Chrome/Edge/Firefox and navigate to the URL.
2. Install as PWA when prompted (Chrome: icon in address bar).
3. Works as standalone window with offline support.

---

## Troubleshooting

### Audio Dropouts (XRUNS)

- Increase buffer size in Settings (256 → 512 → 1024).
- Close other audio apps (Zoom, Spotify, browsers).
- Disable Wi-Fi power saving in Device Manager.

### Followers Not Syncing

- Check all devices are on the same network.
- Verify Leader firewall allows port 4040.
- Restart Leader app and reconnect followers.

### AI Features Not Working

- Verify API key is set (see First Run).
- Check internet connection (AI requires cloud access).
- Review rate limits: max 10 requests/minute.

### PWA Not Installing

- Ensure HTTPS is used (required for PWA install).
- Check browser compatibility (Safari iOS 15+, Chrome Android 90+).
- Clear browser cache and retry.

---

## Support

- GitHub Issues: https://github.com/yourusername/bandait/issues
- Documentation: https://github.com/yourusername/bandait/blob/main/docs/
