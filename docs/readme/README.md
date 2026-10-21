# README images

The images in the repo README are screenshots of `docs/factory-map.html`: one image for each section, in a light and a dark version. GitHub shows the version that matches the reader's theme.

Make the images again after each change to the map:

```bash
cd ~/Workspace/cubilot
npm install --prefix /tmp/cubilot-render playwright@1.56.1
npx --prefix /tmp/cubilot-render playwright install chromium
NODE_PATH=/tmp/cubilot-render/node_modules node docs/readme/render.cjs
```

The script needs network access for the Google fonts of the map. It writes 14 PNG files into this folder. Commit them with the map.
