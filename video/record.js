/**
 * Records the demo video: drives the dApp in a real (headful) Chromium on an Xvfb display, captures it
 * with ffmpeg x11grab, and lays the narration clips at the moment each scene starts.
 *   DISPLAY=:99 node video/record.js
 * Needs: running local chain with a fresh deployment, Vite dev server on :5173, narration in video/build/audio.
 */
const { chromium } = require("playwright");
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const BUILD = path.join(__dirname, "build");
const dur = JSON.parse(fs.readFileSync(path.join(BUILD, "audio", "durations.json"), "utf8"));
const APP = "http://localhost:5173/";
const GAP = 0.7; // seconds of breathing room after each narration clip
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({
    headless: false,
    args: ["--window-size=1440,900", "--window-position=0,0", "--force-device-scale-factor=1.3333333", "--hide-scrollbars", "--disable-infobars", "--no-first-run"],
  });
  const ctx = await browser.newContext({ viewport: null });
  await ctx.addInitScript(() => {
    // visible cursor (synthetic mouse events don't move the X cursor)
    const mk = () => {
      if (document.getElementById("__cursor") || location.pathname.includes("/video/")) return;
      const c = document.createElement("div");
      c.id = "__cursor";
      c.style.cssText =
        "position:fixed;left:0;top:0;width:22px;height:22px;margin:-3px 0 0 -3px;z-index:99999;pointer-events:none;transition:transform .05s linear;" +
        "background:url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='22' height='22'><path d='M3 2 L3 18 L7.5 14 L10.5 20.5 L13 19.4 L10 13 L16 13 Z' fill='white' stroke='black' stroke-width='1.3'/></svg>\") no-repeat;";
      document.documentElement.appendChild(c);
      const pos = JSON.parse(sessionStorage.getItem("__cpos") || "[720,450]");
      c.style.transform = `translate(${pos[0]}px,${pos[1]}px)`;
      addEventListener("mousemove", (e) => {
        c.style.transform = `translate(${e.clientX}px,${e.clientY}px)`;
        sessionStorage.setItem("__cpos", JSON.stringify([e.clientX, e.clientY]));
      }, true);
      addEventListener("mousedown", () => (c.style.filter = "drop-shadow(0 0 6px #3ee08f)"), true);
      addEventListener("mouseup", () => (c.style.filter = ""), true);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mk);
    else mk();
  });
  const page = await ctx.newPage();
  await page.goto(APP + "video/title.html");
  await sleep(1000);
  // size the window so the page viewport is exactly 1440x810 CSS px (= 1920x1080 screen px), then grab
  // only the viewport region (below the browser toolbar)
  const cdp = await ctx.newCDPSession(page);
  const { windowId } = await cdp.send("Browser.getWindowForTarget");
  let m = await page.evaluate(() => ({ ow: outerWidth, oh: outerHeight, iw: innerWidth, ih: innerHeight }));
  await cdp.send("Browser.setWindowBounds", { windowId, bounds: { left: 0, top: 0, width: 1440 + (m.ow - m.iw), height: 810 + (m.oh - m.ih) } });
  await sleep(800);
  m = await page.evaluate(() => ({ ow: outerWidth, oh: outerHeight, iw: innerWidth, ih: innerHeight, sx: screenX, sy: screenY }));
  console.log("window", m);
  const offX = Math.round((m.sx + (m.ow - m.iw)) * 1.3333333);
  const offY = Math.round((m.sy + (m.oh - m.ih)) * 1.3333333);

  const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "x11grab", "-framerate", "30", "-video_size", "1920x1080", "-draw_mouse", "0", "-i", `${process.env.DISPLAY}.0+${offX},${offY}`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", path.join(BUILD, "screen.mp4")], { stdio: ["pipe", "inherit", "inherit"] });
  const t0 = Date.now();
  await sleep(400);
  const marks = {};
  let mouse = [720, 450];
  const move = async (x, y, steps = 25) => {
    await page.mouse.move(x, y, { steps });
    mouse = [x, y];
  };
  const to = async (sel, steps = 25, dx = 0.5, dy = 0.5) => {
    const b = await page.locator(sel).first().boundingBox();
    await move(b.x + b.width * dx, b.y + b.height * dy, steps);
    return b;
  };
  const click = async (sel) => {
    await to(sel);
    await sleep(250);
    await page.mouse.down();
    await sleep(80);
    await page.mouse.up();
  };
  const scrollTo = async (y) => {
    await page.evaluate((y) => window.scrollTo({ top: y, behavior: "smooth" }), y);
    await sleep(900);
  };
  const scrollToSel = async (sel, offset = 120) => {
    const y = await page.evaluate(([s, o]) => document.querySelector(s).getBoundingClientRect().top + scrollY - o, [sel, offset]);
    await scrollTo(y);
  };
  const drag = async (sel, fracs) => {
    const b = await page.locator(sel).first().boundingBox();
    const y = b.y + b.height * 0.5;
    await move(b.x + b.width * 0.5, y, 20);
    await page.mouse.down();
    for (const f of fracs) await move(b.x + b.width * f, y, 45);
    await page.mouse.up();
  };
  const hash = async (h) => {
    await page.evaluate((h) => (location.hash = h), h);
    await sleep(1200);
  };
  async function scene(id, fn) {
    const start = (Date.now() - t0) / 1000;
    marks[id] = start;
    console.log(`${id} @ ${start.toFixed(1)}s`);
    await fn();
    const left = start + dur[id] + GAP - (Date.now() - t0) / 1000;
    if (left > 0) await sleep(left * 1000);
  }

  await scene("title", async () => {});
  await scene("problem", async () => {
    await page.goto(APP + "video/problem.html");
  });
  await scene("how", async () => {
    await page.goto(APP + "#/how");
    await sleep(1500);
    await move(500, 420, 30);
    await sleep(dur.how * 450);
    await scrollToSel(".steps", 260);
    await move(300, 620, 30);
    await sleep(5000);
    await move(760, 620, 40);
    await sleep(5000);
    await move(1200, 620, 40);
  });
  await scene("registry", async () => {
    await hash("#/");
    await to("[data-testid=project-smritivan-bhuj]", 40);
  });
  await scene("smritivan1", async () => {
    await click("[data-testid=project-smritivan-bhuj]");
    await sleep(1800);
    await drag("[data-testid=before-after]", [0.92, 0.95]);
    await sleep(1500);
    await drag("[data-testid=before-after]", [0.08, 0.05]);
    await sleep(1600);
    await drag("[data-testid=before-after]", [0.5]);
  });
  await scene("smritivan2", async () => {
    await click("[data-testid=mode-ndvi]");
    await sleep(600);
    await drag("[data-testid=before-after]", [0.9, 0.12, 0.55]);
    await to(".did-row >> nth=0", 30);
    await sleep(3500);
    await to(".did-row >> nth=1", 30);
    await sleep(2500);
    await to(".did-net", 30);
    await sleep(2500);
    await to(".checks li >> nth=3", 30);
  });
  await scene("smritivan3", async () => {
    await scrollToSel(".kv", 330);
    await to("tr.total", 30);
  });
  await scene("smritivan4", async () => {
    await scrollToSel("[data-testid=submit-attestation]", 420);
    await click("[data-testid=submit-attestation]");
    await page.waitForSelector("[data-testid=issued]", { timeout: 20000 });
    await sleep(600);
    await to("[data-testid=issued]", 30);
  });
  await scene("hasdeo", async () => {
    await hash("#/project/hasdeo-claim");
    await sleep(800);
    await drag("[data-testid=before-after]", [0.95, 0.05, 0.5]);
    await to(".did-net", 30);
    await sleep(2500);
    await scrollToSel("[data-testid=submit-attestation]", 420);
    await click("[data-testid=submit-attestation]");
    await page.waitForSelector("[data-testid=rejected]", { timeout: 20000 });
    await to("[data-testid=rejected]", 30);
  });
  await scene("banni1", async () => {
    await hash("#/project/banni-rain");
    await sleep(600);
    await drag("[data-testid=before-after]", [0.95, 0.06, 0.5]);
    await to(".did-row >> nth=0", 30);
  });
  await scene("banni2", async () => {
    await click("[data-testid=zoom-landscape]");
    await sleep(500);
    await drag("[data-testid=before-after]", [0.95, 0.05, 0.5]);
    await to(".did-row >> nth=1", 30);
    await sleep(1200);
    await to("[data-testid=naive-callout]", 30);
    await sleep(1500);
    await scrollToSel("[data-testid=submit-attestation]", 420);
    await click("[data-testid=submit-attestation]");
    await page.waitForSelector("[data-testid=rejected]", { timeout: 20000 });
    await to("[data-testid=rejected]", 30);
  });
  await scene("retire1", async () => {
    await hash("#/portfolio");
    await sleep(500);
    await click("[data-testid=xfer-amount]");
    await page.keyboard.press("Control+A");
    await page.keyboard.type("250", { delay: 120 });
    await click("[data-testid=xfer]");
  });
  await scene("retire2", async () => {
    await to("[data-testid=persona]", 30);
    await page.selectOption("[data-testid=persona]", "buyer");
    await sleep(1800);
    await to("[data-testid=retire-beneficiary]", 30);
    await sleep(900);
    await click("[data-testid=retire]");
    await page.waitForSelector("[data-testid=certificate]", { timeout: 20000 });
    await sleep(1500);
    await to(".cert-grid .span2 >> nth=0", 30);
    await sleep(2500);
    await scrollTo(170);
    await to(".cert-grid .span2 >> nth=1", 30);
  });
  await scene("explorer", async () => {
    await hash("#/explorer");
    await click("[data-testid=serial-input]");
    await page.keyboard.type("POF-2025-P001-0000042", { delay: 55 });
    await click("[data-testid=serial-lookup]");
    await sleep(2600);
    await to(".two .card >> nth=1", 40);
  });
  await scene("closing", async () => {
    await page.goto(APP + "video/closing.html");
  });
  await sleep(1200);

  ff.stdin.write("q");
  await new Promise((r) => ff.on("exit", r));
  fs.writeFileSync(path.join(BUILD, "marks.json"), JSON.stringify(marks, null, 1));
  await browser.close();
  console.log("recorded", ((Date.now() - t0) / 1000).toFixed(1), "s");
})();
