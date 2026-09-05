# GLOWHUM

Glow is the picture. Hum is the sound.

GLOWHUM turns a topic or a research report into a finished long form episode plus three vertical cuts, published to YouTube, TikTok and Shorts. No human in the loop unless you want one. The unit cost is printed on every receipt. A full creative studio for operators on our own GPU lanes is next on the roadmap.

Glowhum by NOMOI.

## Files

- `index.html` the whole site. One file, inline CSS and JS, inline SVG only, no frameworks, under 120 KB.
- `Dockerfile` serves the site with nginx.

## Run

Open `index.html` in a browser, or serve the container:

```
docker build -t glowhum-web .
docker run --rm -p 8080:80 glowhum-web
```

Then visit http://localhost:8080

## Notes

- Deep indigo night `#0b1026`, warm glow core `#ffb454`, aura edge `#ff7a3d`, one electric accent `#41e6ff`.
- Dark and light themes follow `prefers-color-scheme` with a persisted manual toggle.
- Reduced motion is respected: the breathing glow and the typing demo settle to their final state.
- The Drop a report button uses `mailto:hello@glowhum.com` as a fallback.
- Pricing tiers carry no numbers: launch pricing lands with the first public episode.
