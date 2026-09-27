/**
 * Mock phone screens, rendered in a real browser and encoded as JPEGs.
 *
 * Used only by the rehearsal harness and the prerecorded fallback video. The
 * point is that the fallback video has to be recognisably a phone doing something
 * -- a grey rectangle does not sell the product, and a video that fails to sell
 * the product is worse than no video, because the audience notices.
 *
 * These are deliberately simple, obviously-illustrative mockups. They are never
 * shown as a real device, and `record-demo.mjs` stamps its output as a rehearsal
 * recording. The real `demo.mp4` is recorded with the real phone.
 */

const W = 480;
const H = 854;

const SCREENS = {
  home: { title: "Home", app: "drawer" },
  results: { title: "Search results", app: "results" },
  chat: { title: "Messages", app: "chat" },
  settings: { title: "Settings", app: "settings" },
  recents: { title: "Recent apps", app: "recents" },
  notifications: { title: "Notifications", app: "notifications" },
  scroll: { title: "Feed", app: "feed" },
  context: { title: "Long press", app: "context" },
  zoom: { title: "Zoomed", app: "zoom" },
  camera: { title: "Camera", app: "camera" },
};

export const SCREEN_NAMES = Object.keys(SCREENS);

/**
 * Renders every screen to a JPEG buffer using the supplied browser.
 * Returns Map<name, Buffer>.
 */
export async function renderScreens(browser, names = SCREEN_NAMES) {
  const page = await browser.newPage();
  const out = new Map();

  for (const name of names) {
    const dataUrl = await page.evaluate(
      ({ html, w, h }) => {
        const host = document.createElement("div");
        host.innerHTML = html;
        host.style.cssText = `width:${w}px;height:${h}px;position:relative;overflow:hidden;
          font-family:-apple-system,"Segoe UI",Roboto,sans-serif;background:#0b0f14`;
        document.body.appendChild(host);

        // Allow webfonts/layout to settle before encoding.
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const url = c.toDataURL("image/jpeg", 0.82);

        host.remove();
        return url;
      },
      { html: markupFor(name), w: W, h: H }
    );
    out.set(name, Buffer.from(dataUrl.split(",")[1], "base64"));
  }

  await page.close();
  return out;
}

function markupFor(name) {
  const s = SCREENS[name] || SCREENS.home;
  return `
  <div class="scr" style="color:#e6edf3">

    <!-- status bar -->
    <div style="height:26px;display:flex;align-items:center;justify-content:space-between;
                padding:0 14px;font-size:12px;background:#000;color:#fff">
      <span>9:41</span>
      <span style="letter-spacing:1px">▮▮▮ 5G ▰</span>
    </div>

    <!-- app bar -->
    <div style="height:52px;display:flex;align-items:center;padding:0 16px;
                font-size:19px;font-weight:600;background:#11161d;
                border-bottom:1px solid #1e2731">${s.title}</div>

    ${bodyFor(s.app)}

    <!-- gesture bar -->
    <div style="position:absolute;bottom:7px;left:50%;transform:translateX(-50%);
                width:132px;height:4px;border-radius:2px;background:#4a5563"></div>
  </div>`;
}

function bodyFor(app) {
  const card = (title, sub, tint) => `
    <div style="margin:12px;padding:14px;border-radius:12px;background:#151c24;
                border:1px solid #1e2731">
      <div style="font-size:15px;font-weight:600">${title}</div>
      <div style="font-size:12.5px;color:#8b98a5;margin-top:3px">${sub}</div>
      <div style="margin-top:10px;height:4px;border-radius:2px;background:${tint}"></div>
    </div>`;

  const rows = (items) => items.map(([t, s]) => `
    <div style="padding:13px 16px;border-bottom:1px solid #1a222b;display:flex;
                align-items:center;gap:12px">
      <div style="width:32px;height:32px;border-radius:8px;background:#22303d;flex:none"></div>
      <div><div style="font-size:14.5px">${t}</div>
      <div style="font-size:12px;color:#8b98a5">${s}</div></div>
    </div>`).join("");

  switch (app) {
    case "results":
      return `
        <div style="margin:12px;padding:11px 13px;border-radius:10px;background:#151c24;
                    border:1px solid #2c3a48;font-size:14px">
          break remote <span style="color:#4ade80">▍</span>
        </div>
        ${card("Break Remote", "Remote control agent · dev.breakremote.agent", "#4ade80")}
        ${card("Remote access", "Settings › Accessibility", "#60a5fa")}
        ${card("Wireless debugging", "Settings › Developer options", "#fbbf24")}`;

    case "chat":
      return `
        <div style="padding:16px;display:flex;flex-direction:column;gap:10px">
          <div style="align-self:flex-start;max-width:74%;padding:10px 13px;border-radius:14px 14px 14px 4px;
                      background:#1c242e;font-size:14px">Are you still on for the demo?</div>
          <div style="align-self:flex-end;max-width:74%;padding:10px 13px;border-radius:14px 14px 4px 14px;
                      background:#1f6f45;font-size:14px">Yes — phone is on 4G, laptop on venue wifi</div>
          <div style="align-self:flex-end;max-width:74%;padding:10px 13px;border-radius:14px 14px 4px 14px;
                      background:#1f6f45;font-size:14px">It works 🎉</div>
        </div>`;

    case "settings":
      return rows([
        ["Network & internet", "Wi-Fi, mobile, data usage"],
        ["Connected devices", "Bluetooth, pairing"],
        ["Accessibility", "TalkBack, Magnification"],
        ["Battery", "62% · 4h 12m left"],
        ["Display", "Brightness, dark theme"],
        ["Screen timeout", "30 minutes"],
      ]);

    case "recents":
      return `<div style="padding:16px;display:flex;gap:12px;overflow:hidden">
        ${["Settings", "Messages", "Camera", "Files"]
          .map((n) => `<div style="flex:none;width:150px;height:290px;border-radius:12px;
            background:#161d25;border:1px solid #232c35;padding:12px">
            <div style="font-size:13px;font-weight:600">${n}</div>
            <div style="margin-top:8px;height:60px;border-radius:8px;background:#1d2731"></div>
            <div style="margin-top:8px;height:36px;border-radius:8px;background:#1d2731"></div>
          </div>`).join("")}
      </div>`;

    case "notifications":
      return rows([
        ["Break Remote is controlling this phone", "Tap to open the app"],
        ["Screen timeout", "30 minutes"],
        ["Battery saver", "Off"],
      ]);

    case "feed":
      return rows([
        ["Item one", "Scroll to see more"],
        ["Item two", "Long press for options"],
        ["Item three", "Drag to reorder"],
        ["Item four", "Swipe scrolled this"],
        ["Item five", "Still scrolling"],
        ["Item six", "Frame rate held"],
      ]);

    case "context":
      return `
        <div style="margin:24px;padding:16px;border-radius:12px;background:#151c24;
                    border:1px solid #2c3a48">
          <div style="font-size:14px;font-weight:600;margin-bottom:12px">Selected</div>
          ${["Copy", "Share", "Rename", "Delete"].map((x) =>
            `<div style="padding:10px 0;border-top:1px solid #1e2731;font-size:14px">${x}</div>`).join("")}
        </div>`;

    case "zoom":
      return `
        <div style="margin:12px;height:600px;border-radius:12px;
                    background:linear-gradient(140deg,#1d4ed8,#0ea5e9);display:flex;
                    align-items:center;justify-content:center;font-size:40px">200%</div>`;

    case "camera":
      return `
        <div style="margin:12px;height:600px;border-radius:12px;position:relative;
                    background:linear-gradient(160deg,#334155,#0f172a)">
          <div style="position:absolute;inset:14px;border:2px solid rgba(255,255,255,.25);
                      border-radius:8px"></div>
          <div style="position:absolute;bottom:26px;left:50%;transform:translateX(-50%);
                      width:66px;height:66px;border-radius:50%;background:#fff;
                      border:4px solid #94a3b8"></div>
        </div>`;

    default: // home / drawer
      return `
        <div style="padding:16px;display:grid;grid-template-columns:repeat(4,1fr);gap:16px 8px">
          ${["Phone", "Messages", "Camera", "Settings", "Maps", "Clock", "Files", "Store",
             "Play", "Photos", "Notes", "Music", "Mail", "Weather", "Wallet", "Podcasts",
             "Home", "Tasks", "Wallet", "Contacts", "Recorder", "Translate", "Drive", "Fit"]
            .map((n) => `<div style="text-align:center">
              <div style="width:52px;height:52px;margin:0 auto;border-radius:13px;
                          background:linear-gradient(140deg,#253241,#1a222c);
                          border:1px solid #2c3846"></div>
              <div style="font-size:10.5px;color:#9aa7b4;margin-top:5px">${n}</div>
            </div>`).join("")}
        </div>`;
  }
}

export const SCREEN_SIZE = { w: W, h: H };
