# crbuddy promo video

A 35-second, 1080p60 promo with sound effects and no music. There are no
video tools and no AI generation: it is a web page rendered frame by frame
in headless Chromium, with the sound synthesized in plain Node and ffmpeg
putting it together.

| File | What it does |
|---|---|
| `timeline.js` | The cue sheet: every timing, and all the terminal text. The visuals and the audio both load it, so they cannot drift apart. |
| `scene.js`, `style.css`, `index.html` | The page. `render(t)` sets every element from `t` alone - no CSS animations or timers - so frames render in any order. |
| `render.mjs` | Playwright loads the page, calls `render(i / 60)` per frame and screenshots it, with 8 pages in parallel. |
| `audio.mjs` | Key clicks, pops, whooshes, the terminal bell and the rest, synthesized sample by sample into `out/audio.wav`. |
| `build.mjs` | Runs both, then encodes `out/crbuddy-promo.mp4` (H.264/AAC). |
| `fonts/` | Bricolage Grotesque, Inter and JetBrains Mono (OFL), plus DejaVu Sans Mono for the braille spinner. Their licenses sit alongside. |

The terminal text is what crbuddy and clack really print. Versions, counts,
hashes, times and the review findings are made up.

```bash
npm install
npx playwright install chromium-headless-shell   # add --with-deps on a fresh Linux box
npm run build       # out/crbuddy-promo.mp4, about a minute (-- --name crbuddy-promo-2 to rename)
npm run preview     # live, scrubbable player at http://localhost:4173
npm run stills -- 5.5,19,22.2   # PNG stills in stills/, for checking a moment
```
