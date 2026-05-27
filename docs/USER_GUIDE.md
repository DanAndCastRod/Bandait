# Bandait User Guide

## Overview

Bandait is a real-time rehearsal and live performance assistant for bands. It synchronizes tempo, lyrics, and setlists across all band members' devices.

**Leader** (desktop): Controls the session, plays multichannel audio, records rehearsals, manages setlists and gigs.

**Followers** (phones/tablets): Display lyrics, chords, and metronome visual cues in sync with the leader.

---

## Quick Start — Rehearsal

### 1. Leader: Start the Session

1. Open **Bandait Leader** on your laptop.
2. Click **PLAY** (or press `Space`) to start the metronome.
3. The app shows a QR code. Band members scan it with their phones.

### 2. Followers: Connect

1. Open camera app, scan QR code.
2. Tap the link to open Bandait PWA.
3. Select your role (Vocals, Drums, Guitar, etc.).
4. The screen shows lyrics/chords in sync.

### 3. During Rehearsal

- **Leader**: Use transport controls (Play/Stop/Rec) or keyboard shortcuts.
- **Followers**: Screen auto-scrolls lyrics, flashes metronome on beat 1.
- **Recording**: Leader clicks **REC** to record all audio inputs.

### 4. End Rehearsal

- Click **STOP** (or press `Esc`).
- Recordings save automatically.
- AI analysis available in **Rehearsals** tab.

---

## Keyboard Shortcuts (Leader)

| Key | Action |
|-----|--------|
| `Space` | Play / Stop toggle |
| `R` | Record toggle |
| `Esc` | Panic stop (immediate, no fade) |
| `F11` | Toggle full-screen Stage Mode |
| `Tab` | Switch between Library / Gigs / Rehearsals / AI |
| `+` / `-` | Increase / decrease BPM |
| `↑` / `↓` | Next / previous song in setlist |

---

## Workflows

### Creating a Setlist

1. Go to **Library** tab.
2. Click **+ New Setlist**.
3. Drag songs from library or click **+ Add Song**.
4. Reorder by dragging.
5. Click **Save**.

### Importing Songs

1. In **Library** → Song Editor, click **Import LRC / ChordPro**.
2. Select `.lrc` (lyrics with timestamps) or `.pro`/`.cho` (ChordPro format).
3. Edit title, BPM, key if needed.
4. Click **Save Song**.

### Scheduling a Gig

1. Go to **Gigs** tab.
2. Click **+ New Event**.
3. Fill name, venue, date.
4. Select a setlist from dropdown.
5. Save. The gig appears in the list.

### Loading a Gig for Performance

1. In **Gigs**, select the event.
2. Click **Load for Session**.
3. The setlist loads into the transport.
4. Go to **Stage** tab for full-screen performance view.

### AI Analysis

1. After rehearsal, go to **Rehearsals** tab.
2. Select the rehearsal.
3. Click **Analyze with AI**.
4. Review tempo consistency, energy flow, and suggestions.

### AI Chat

1. Go to **AI** tab.
2. Type questions like:
   - "What songs should we rehearse more?"
   - "Suggest a 45-minute setlist for a bar gig."
   - "How do we fix the tempo drift in Song X?"
3. AI responds with actionable advice.

---

## Stage Mode

Optimized for live performance:

- **Full screen**: No window chrome, maximum brightness.
- **Minimal UI**: Only lyrics, BPM, and next song.
- **Visual metronome**: Screen edges flash on beat 1 (cyan), beats 2-4 (subtle).
- **Network beacon**: Top bar shows connection health (green/yellow/red).
- **Slide to stop**: Prevents accidental stops during performance.

Activate: Press `F11` or click **Stage** tab.

---

## Follower Views by Role

| Role | Display |
|------|---------|
| **Vocals** | Large lyrics, small chords above |
| **Drums** | BPM large, structure (Intro/Verse/Chorus), click visual |
| **Guitar/Bass** | Chords large, lyrics small below |
| **Keys** | Chords + lyrics, BPM |
| **Director** | Everything + controls + network health |

---

## Tips for Live Gigs

1. **Test Wi-Fi** at the venue before the show. Use leader hotspot if venue Wi-Fi is unreliable.
2. **Charge devices** — PWA screen-on drains battery fast. Bring power banks.
3. **Set brightness to max** in Stage Mode for outdoor/daylight shows.
4. **Have a backup plan** — printed setlist or lyric sheets if tech fails.
5. **Record every show** — Leader auto-saves recordings. Review later for improvement.

---

## Data Management

- **Database**: `Documents/Bandait/bandait.db` — songs, setlists, gigs.
- **Recordings**: `Documents/Bandait/Recordings/YYYY-MM-DD/` — multitrack FLAC.
- **Backups**: Copy `bandait.db` to cloud (Dropbox, Google Drive) periodically.
