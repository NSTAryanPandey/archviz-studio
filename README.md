# ArchViz Luxury Studio 🏛️

A realistic, multiplayer interior-design sandbox in the browser. Walk through a sunlit apartment, furnish it with scanned furniture, and build together with friends in real time.

Built with **three.js** (rendering), **Express** (web server) and **Socket.IO** (real-time sync).

## Run it

```bash
npm install
npm start
```

Open **http://localhost:3000**. To play with friends:

- **Same Wi-Fi:** find your laptop's IP address (`ipconfig getifaddr en0` on macOS, `ipconfig` on Windows) and send them `http://<your-ip>:3000/?room=myroom`.
- **Anywhere:** deploy it (see below) and use the **Copy invite link** button in the game.

Everyone with the same `?room=` link builds in the same apartment. Rooms are saved to `data/rooms.json`, so your layout is still there after a restart.

Opening `public/index.html` directly (without the server) still works, in single-player mode.

## Play on your phone

1. Connect the phone to the **same Wi-Fi** as the laptop.
2. Run `npm start`. Terminal prints a phone link and a **QR code**: scan it with the phone camera.
3. On macOS, if a popup asks *"Allow node to accept incoming connections?"*, click **Allow**.

Phone controls: left stick to walk (push past the edge to run), swipe to look, pinch to zoom, aim the centre dot, then tap **＋ Place** / **⟳** / **🗑️**.

If the phone can't connect, the Wi-Fi may block devices from seeing each other (common on college and office networks). Turn on your phone's **hotspot**, connect the laptop to it, restart `npm start`, and scan the new QR code.

## Controls

| Input | Action |
|---|---|
| WASD / Shift | Move / run |
| Two-finger swipe, arrow keys, or drag | Look around |
| Pinch | Zoom (lens focal length) |
| Tap / click on the floor | Place the selected furniture |
| Click on furniture | Pick it up and move it (click again to drop, Esc / right-click to cancel) |
| Cmd/Ctrl + Z, Cmd/Ctrl + Shift + Z | Undo / redo (or the ↶ ↷ buttons) |
| Two-finger tap / right-click / E | Delete |
| R | Rotate the item you're placing or carrying |
| Z / X or 1–0 | Choose item |
| N / T | Day ↔ night / rain (shared with the room) |
| Q | Quality preset (High / Medium / Low) |
| [ ] | Exposure |
| H | Photo mode (hides UI, depth of field) |
| P | Save a screenshot |
| F | Mouse-lock FPS mode (desktop browsers only) |

## How the multiplayer works

```
client ──place {tempId,type,x,z,rot,aabb}──▶ server ── validates ──▶ placed {item,tempId} ──▶ all clients
client ──remove {id}──────────────────────▶ server ──────────────▶ removed {id}
client ──move {x,z,yaw} ×12/s (volatile)──▶ server ──────────────▶ playerMoved ──▶ other clients
client ──lock {id} → drag ×10/s → objMove {id,x,z,rot,aabb}  (or unlock to cancel)
client ──env {night,rain}─────────────────▶ server ──────────────▶ env
```

- **The server is the source of truth.** It rejects placements that overlap, fall outside the room, or come too fast.
- **Optimistic UI.** Your placement appears instantly with a temporary id. The server confirms it with a real id, or rejects it and it disappears.
- **Smooth avatars.** Positions arrive about 12 times a second and each client interpolates between them every frame.

## Performance features

- Shadow maps re-render only when something changes, not every frame.
- A fixed light pool, so placing a lamp no longer recompiles every shader.
- Each bookshelf is merged into 2 meshes instead of about 150.
- Rain is animated entirely on the GPU.
- Quality drops automatically when FPS stays below 40, and Q switches preset manually.

## Deploy (free)

**Render:** New → Web Service → connect this repo → Build `npm install`, Start `npm start`. Render sets `PORT` for you.

Note: on free hosting the disk is temporary, so `data/rooms.json` resets when the service restarts. Swap the JSON file for MongoDB (Atlas free tier, with Mongoose) to keep rooms permanently. Only `loadRooms()` and `saveSoon()` in `server.js` need to change.

## Credits

Furniture models and floor textures: [Poly Haven](https://polyhaven.com) (CC0). Downloaded at runtime; procedural fallbacks are used if they can't load.

## Ideas / next steps

- Text chat and voice
- MongoDB persistence and accounts
- Baked lightmaps from Blender for photoreal global illumination
