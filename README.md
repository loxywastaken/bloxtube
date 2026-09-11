# BloxTube

A modern video-platform prototype with a **real account backend** and a glossy glass (iOS-style) interface. Real sign-up / sign-in, uploads, comments, subscriptions, and a clean admin panel — all persisted on a server, not in your browser.

- **Front-end:** one self-contained `index.html` (glass UI, no build step)
- **Back-end:** `server.js` — a zero-dependency Node server (API + static hosting)
- **First account created becomes the OWNER** (full admin). Passwords are hashed with scrypt.

---

## Host it online (recommended — nothing to run on your PC)

You'll put the code on **GitHub**, deploy the server free on **Render**, and (optionally) add a free **Upstash** datastore so accounts stick forever. All in the browser.

### 1 · Put the code on GitHub
- Go to **github.com → New repository**, name it `bloxtube`, click **Create repository**.
- On the new repo page click **“uploading an existing file”**, then drag in these files:
  `index.html`, `server.js`, `package.json`, `render.yaml`, `README.md`
  *(skip the `data` folder — it's local only).* Click **Commit changes**.
- *(Prefer git? `git init && git add . && git commit -m "BloxTube" && git branch -M main && git remote add origin YOUR_REPO_URL && git push -u origin main`.)*

### 2 · Deploy the backend on Render (free)
- Go to **render.com** and sign up (you can sign in with GitHub).
- Click **New + → Web Service → Build and deploy from a Git repository**, and pick your `bloxtube` repo.
- Render auto-detects Node from `render.yaml`/`package.json`. Confirm:
  - **Start command:** `node server.js`  · **Instance type:** Free
- Click **Create Web Service**. After ~1–2 minutes you get a live URL like `https://bloxtube-xxxx.onrender.com`.
- Open it → **create your account** (you're the owner). Share the URL — anyone can sign up. 🎉

> One-click alternative: `https://render.com/deploy?repo=YOUR_REPO_URL` (works because `render.yaml` is in the repo).

### 3 · Make accounts permanent (free, ~2 min) — recommended
On Render's free tier the server's local file resets when the instance sleeps/restarts, so accounts would vanish. Point it at a tiny free Redis to keep everything:
- Go to **upstash.com** → sign up → **Create Database → Redis** → pick a region → **Create**.
- On the database page open the **REST API** section and copy **`UPSTASH_REDIS_REST_URL`** and **`UPSTASH_REDIS_REST_TOKEN`**.
- In **Render → your service → Environment**, add those two variables (same names) → **Save changes**. Render redeploys and now uses Upstash automatically — accounts and content persist across restarts.

*Notes:* Free Render web services sleep after ~15 min idle and take ~30s to wake on the next visit — normal for the free tier. The prototype stores data as one JSON blob, which is plenty for a demo/small community.

---

## Or run it locally

Needs **Node.js 18+**. No install step, zero dependencies.

- **Windows:** double-click **`Start BloxTube.bat`** — it starts the server and opens the site.
- **Any OS / terminal:**
  ```bash
  cd bloxtube
  node server.js
  ```
  Then open **http://localhost:3000** (not the `index.html` file directly — it needs the running server).

To persist locally it just writes `./data/db.json`. Set `PORT=8080` to change the port.

---

## What's real vs simulated

**Real & persisted on the server:** accounts + sessions, uploads (metadata), views, likes, threaded comments, subscriptions + feed, playlists, history, notifications, reports, and all admin actions (with an audit log).

**Prototype/simulated (clearly labelled in the UI):** actual video playback/transcoding, "live", and Plus billing. Thumbnails/avatars are generated placeholder art so real content looks good without uploading image files.

Original BloxTube branding and content only.
