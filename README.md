# Dream Team: Cricket Draft Game

A mobile-first web app. You spin a World Cup year, draft your XI country by country and play the tournament. You can also duel your friends live, 1 v 1.

- **Live duel server**: Socket.IO shows who's online and sends invites on the spot. Your rival's draft progress appears in real time and the match day plays out on both phones at once.
- **Google sign-in**: your XP, cards, trophies, streak and duels are saved to your Google account and load on any device.
- **Global leaderboard**: each signed-in player can only write their own row.
- **Duel inbox**: you can challenge a player who isn't online. The invite waits in their inbox.
- **Duel links**: "Send" shares a link that opens the challenge directly.
- **Installable**: it's a PWA, so players can add it to their home screen. It opens instantly and works offline, but duels and saving need a connection.

## What's inside

```
index.html            app shell (fonts, icons, manifest)
src/main.js           boots the app: config → account → server connection → game
src/account.js        Google sign-in, profile load/merge, auto-save of progress
src/platform.js       the game's services over Socket.IO: room (who's online), db (leaderboard + inbox), user, downloads
src/app.css           boot splash, account card, sign-in sheet
src/game/game.js      the game engine (screens, draft, simulation, duels, animations)
src/game/style.css    the game's styles
server/index.js       Express + Socket.IO: auth, profiles, live presence, leaderboard/duel rules
server/db.js          SQLite storage (built into Node 22, nothing native to compile)
public/               manifest, service worker, icons
```

**Why vanilla JS and not React?** The game is a hand-tuned canvas and CSS animation engine. A framework would add re-render overhead without making anything smoother. Vite builds and minifies everything, and the game itself stays as fast as it is in the design prototype.

## Run it locally

You need Node 22.13 or newer.

```bash
npm install
cp .env.example .env        # DEV_LOGIN=1 lets you sign in as test players without Google
npm run dev                 # server on :8787, app on http://localhost:5173
```

To try a duel, open the app in two different browsers, or one normal window and one private window. Sign in as two test players and challenge each other from **Duel a friend**.

Production-style run:

```bash
npm run build && npm start  # serves the built app and the duel server on :8787
```

## Set up Google sign-in (10 minutes)

1. Go to <https://console.cloud.google.com/> and create a project, for example "Dream Team".
2. Open **APIs & Services → OAuth consent screen**.
   - Choose **External** and fill in the app name, support email and logo.
   - The scopes are just the defaults: email, profile, openid.
   - While testing, add your friends as **Test users**. Click **Publish app** when you go live.
3. Open **APIs & Services → Credentials → Create credentials → OAuth client ID**.
   - Application type: **Web application**.
   - **Authorized JavaScript origins**: `http://localhost:5173`, `http://localhost:8787` and your live address, for example `https://dream-team.onrender.com`.
   - No redirect URIs are needed.
4. Copy the client ID, which looks like `1234-abc.apps.googleusercontent.com`. Set it as `GOOGLE_CLIENT_ID` in `.env` and on your host.

The app only asks Google for name, email and photo. Other players never see your email or Google ID: each player gets an opaque public ID.

## Deploy

### Render (easiest)

1. Push this folder to a GitHub repo.
2. In Render, click **New → Blueprint** and pick the repo. It reads `render.yaml`, which sets up:
   - a Node web service on the Starter plan, which stays awake (the free plan sleeps and drops live duels);
   - a 1 GB persistent disk for the database;
   - a generated `SESSION_SECRET`.
3. Paste `GOOGLE_CLIENT_ID` when Render asks, then add the Render URL to the Google client's **Authorized JavaScript origins**.

### Anywhere with Docker (Railway, Fly.io, a VPS)

```bash
docker build -t dream-team .
docker run -p 8080:8080 -v dt-data:/data \
  -e SESSION_SECRET=$(openssl rand -hex 32) \
  -e GOOGLE_CLIENT_ID=your-client-id \
  dream-team
```

Mount a volume at `/data` so profiles survive restarts. Put the site behind HTTPS. Most hosts do this for you, and Google sign-in requires it outside localhost.

### Environment variables

| Name | Needed | What it does |
|---|---|---|
| `GOOGLE_CLIENT_ID` | yes | Google OAuth web client ID |
| `SESSION_SECRET` | yes in production | Signs login cookies. Use a long random string. |
| `DB_PATH` | no | SQLite file path. Default: `./data/dream-team.db` |
| `PORT` | no | Default: 8787 |
| `ALLOWED_ORIGINS` | no | Extra origins allowed to open a socket, comma separated |
| `DEV_LOGIN` | local only | `1` enables test sign-in. It is always off when `NODE_ENV=production`. |

## How duels work

1. A player creates a duel, drafts and locks their team. They then challenge someone in one of three ways:
   - **Online now**: an invite pops up on the rival's screen.
   - **Inbox**: saved on the server for signed-in players.
   - **Link or code**: works for anyone.
2. The rival accepts and drafts their own team with their own random spins. The challenger watches "Drafting · n/11" live.
3. When both teams are locked, both phones run the same seeded simulation, so they see identical results. Match day plays out as an animated timeline. Dream Score is team strength plus win points:
   - group win +40
   - quarter-final +150
   - semi-final +200
   - final +400

## Server rules

- Only signed-in players can write.
- A player can only write their own leaderboard row.
- A duel record can only be created by its host and updated by its host or guest. Its players can't be swapped.
- Duel records can only be read by the two players in them.
- Presence messages are capped at 4 KB.
- Writes are rate-limited per connection.
- Duel invites older than 30 days are cleaned up daily.

## Before a big launch

- **Scores are reported by the player's phone.** For a competitive leaderboard, move the tournament simulation to the server (the simulation is deterministic, so it can be re-run there from the drafted XI and seed).
- **One server instance handles a lot of players.** To run several instances, add the Socket.IO Redis adapter and move storage to Postgres. `server/db.js` is the only file that touches storage.
- **Legal pages.** Google requires a privacy policy and terms of service URL on the consent screen before you publish.
- **Sponsor branding.** The MRF banner on the ground needs the sponsor's permission.
- **Payments.** Shop purchases are still simulated.
