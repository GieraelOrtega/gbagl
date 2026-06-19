# 💕 GBAGL — Gunna Be a Great Life

> A romantic date-planning website for **gba.gl** — a heartfelt 1-year anniversary surprise.

**GBAGL** is a cute, mobile-friendly website with three pages:

| Page | URL | What it does |
|------|-----|-------------|
| **Home** | `/` | Hero photo collage + introduction |
| **Adventure** | `/adventure` | Date-idea planner — save, favourite, and mark as done |
| **Timeline** | `/timeline` | Scrollable history of your relationship milestones |

Built with **Node.js + Express + EJS + MySQL**, deployed on **Gandi.net** web hosting.

---

## Table of Contents

1. [Running locally](#1-running-locally)
2. [Setting up the database](#2-setting-up-the-database)
3. [Deploying to Gandi.net](#3-deploying-to-gandinet)
4. [Personalizing the site](#4-personalizing-the-site)
5. [Project structure](#5-project-structure)

---

## 1. Running locally

### Prerequisites
- [Node.js](https://nodejs.org/) v20 or newer (check with `node --version`)
- A MySQL database (optional — the site works without one, the Adventure save/load features are just disabled)

### Steps

```bash
# 1. Clone the repo
git clone https://github.com/GieraelOrtega/gbagl.git
cd gbagl

# 2. Install dependencies
npm install

# 3. Create your environment file
cp .env.example .env
# Now open .env in a text editor and fill in your database details
# (If you have no DB yet, leave the defaults — the site still runs!)

# 4. Start the server
npm start
# → Open http://localhost:3000 in your browser
```

For **development** (auto-restarts when you save a file):

```bash
npm run dev
```

---

## 2. Setting up the database

The Adventure planner saves date ideas to a MySQL database.
The app automatically creates the `date_ideas` table on startup — you just need an empty database and a user with access.

### Create a database and user (run in your MySQL client)

```sql
-- Create the database
CREATE DATABASE gbagl_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create a dedicated user (replace 'yourpassword' with something strong)
CREATE USER 'gbagl_user'@'localhost' IDENTIFIED BY 'yourpassword';

-- Grant that user access to the database
GRANT ALL PRIVILEGES ON gbagl_db.* TO 'gbagl_user'@'localhost';
FLUSH PRIVILEGES;
```

Then update your `.env` file:

```env
DB_HOST=localhost
DB_PORT=3306
DB_USER=gbagl_user
DB_PASSWORD=yourpassword
DB_NAME=gbagl_db
```

Restart the server (`npm start`) and you should see:
```
✅  Database connected and tables ready!
```

That's it! The `date_ideas` table is created automatically.

---

## 3. Deploying to Gandi.net

> These steps assume you've chosen **Node.js** as the language and **MySQL** as the database in your Gandi hosting dashboard.

### 3a. Get your deployment credentials

1. Log into your [Gandi dashboard](https://admin.gandi.net).
2. Go to **Web Hosting → your hosting plan**.
3. Find the **SFTP/SSH** credentials (host, port, username, password).
4. Find the **MySQL** credentials (host, port, database name, username, password) — usually listed under **Databases**.

### 3b. Upload your code (SFTP)

Using a tool like [FileZilla](https://filezilla-project.org/) or the command line:

```bash
# Example using sftp from the terminal
sftp -P <sftp-port> <sftp-user>@<sftp-host>

# Inside the sftp prompt, upload everything except node_modules and .env:
put -r . /path/to/htdocs
```

> 💡 **Tip:** You can also push via Git if Gandi provides a Git remote — check your dashboard for "Git deploy" or "Git push" options.

### 3c. Set environment variables on Gandi

Gandi's Node.js hosting usually lets you set environment variables in the dashboard or via a configuration file (`.env` or a hosting-specific config panel). Look for an **"Environment variables"** or **"Configuration"** section.

Set all five DB variables, plus `PORT` if required:

```
PORT=<assigned by Gandi, often 3000 or set automatically>
DB_HOST=<your Gandi MySQL host, e.g. yourdomain.mysql.db>
DB_PORT=3306
DB_USER=<your DB username>
DB_PASSWORD=<your DB password>
DB_NAME=<your DB name>
```

> ⚠️  **Never put your real `.env` in the repo.** The `.gitignore` already excludes it.

### 3d. Install dependencies & start the app

Via SSH or the Gandi control panel terminal:

```bash
cd /path/to/your/app
npm install --omit=dev   # installs only production dependencies
npm start
```

If Gandi manages the Node process automatically, it will typically look for a `start` script in `package.json` — which is already set to `node server.js`.

### 3e. Point your domain

In the Gandi DNS/domain settings, make sure `gba.gl` (and/or `www.gba.gl`) points to your hosting. If the hosting is on the same Gandi account, there's usually a one-click option to link the domain.

> 🔍 **When in doubt:** Check Gandi's [official Node.js hosting docs](https://docs.gandi.net) or open a support ticket — they're helpful!

---

## 4. Personalizing the site

### Add real photos

1. Drop your `.jpg` / `.png` photos into `/public/images/`.
2. Open `views/index.ejs` and update the `src` attributes in the collage section:

```html
<!-- Before (placeholder) -->
<img src="/images/photo-1.svg" alt="..." />

<!-- After (your real photo) -->
<img src="/images/us-at-paris.jpg" alt="Us in Paris 🗼" />
```

### Edit the timeline milestones

Open `data/timeline.js` — it's a simple array of objects. Edit the `date`, `title`, `description`, and optionally add a `photo` path:

```js
{
  date:        'June 2024',               // When it happened
  title:       'The Day We Met',
  description: 'We bumped into each other at the bookstore...',
  emoji:       '✨',
  photo:       'images/day-we-met.jpg',   // Optional — null to skip
},
```

### Change colors or fonts

Open `public/css/style.css` and edit the `:root` block at the top:

```css
:root {
  --color-primary: #e8677a;   /* Main pink — change to any color */
  --font-heading: 'Playfair Display', serif;  /* Heading font */
  /* ... */
}
```

### Change the tagline or copy

- **Hero text:** `views/index.ejs` (the `<section class="hero">` block)
- **Adventure page intro:** `views/adventure.ejs`
- **Timeline intro:** `views/timeline.ejs`

---

## 5. Project structure

```
gbagl/
├── server.js              ← App entry point (start here)
├── db.js                  ← MySQL connection + table setup
├── package.json
├── .env.example           ← Copy to .env and fill in your values
├── .gitignore
├── .nvmrc                 ← Node version hint
│
├── routes/
│   ├── index.js           ← Landing page route
│   ├── adventure.js       ← Date planner routes (CRUD)
│   └── timeline.js        ← Timeline route
│
├── data/
│   └── timeline.js        ← ✏️ Edit your milestone data here
│
├── views/
│   ├── index.ejs          ← Landing page template
│   ├── adventure.ejs      ← Adventure planner template
│   ├── timeline.ejs       ← Timeline template
│   ├── 404.ejs            ← 404 error page
│   └── partials/
│       ├── head.ejs       ← <head> tag (shared)
│       ├── nav.ejs        ← Navigation bar (shared)
│       └── footer.ejs     ← Footer (shared)
│
└── public/
    ├── css/style.css      ← ✏️ All styles (edit colors/fonts here)
    ├── js/main.js         ← Client-side JS (mobile nav, alerts)
    └── images/            ← ✏️ Drop your real photos here
        ├── photo-1.svg    ← Placeholder — replace with your photo
        └── ...
```

---

Made with 💕 for us. *Gunna Be a Great Life.*
