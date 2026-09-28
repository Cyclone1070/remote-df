/**
 * Reproduce the permanent "CONNECTING WEBRTC P2P..." freeze by rapidly
 * opening/closing the Settings menu — left-click to open, right-click to
 * dismiss — exactly as the user was doing when it froze.
 *
 * Does NOT click Quit. Does NOT inject code. Only natural mouse clicks.
 */
const { chromium } = require('playwright');

const URLS = [
  { label: 'Direct IP', url: 'http://100.73.151.90:8484/df' },
  { label: 'Cloudflare', url: 'https://gmc-bond-strategies-vocals.trycloudflare.com/df' },
];

// Title screen button coordinates (1544x928 viewport)
const SETTINGS_BTN = { x: 768, y: 579 };
const RAPID_CYCLES = 30;          // 30 rapid open/close cycles
const MIN_DELAY_MS = 50;          // minimum delay between clicks
const MAX_DELAY_MS = 200;         // maximum delay between clicks

async function resetSession() {
  const res = await fetch('http://100.73.151.90:8484/api/session');
  const data = await res.json();
  if (data.state === 'running') {
    await fetch('http://100.73.151.90:8484/api/session/stop', { method: 'POST' });
    await new Promise(r => setTimeout(r, 3000));
  }
  await fetch('http://100.73.151.90:8484/api/session/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gameId: 'dwarf-fortress' })
  });
  await new Promise(r => setTimeout(r, 5000));
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function testUrl({ label, url }) {
  console.log(`\n=== Testing: ${label} (${url}) ===`);
  
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1544, height: 928 } });
  const page = await context.newPage();

  // Collect console logs
  const logs = [];
  page.on('console', msg => {
    const text = msg.text();
    logs.push(text);
    if (text.includes('WebRTC') || text.includes('DataChannel') || text.includes('closed')) {
      console.log(`  [CONSOLE] ${text}`);
    }
  });

  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  console.log('  Page loaded, waiting for WebRTC...');

  // Wait for WebRTC DataChannel to open
  const dcReady = await page.waitForFunction(
    () => {
      // Check for the overlay to disappear (isWebRTCReady = true)
      const overlay = document.querySelector('.backdrop-blur-sm');
      return !overlay;
    },
    { timeout: 30000 }
  ).catch(() => false);

  if (!dcReady) {
    console.log('  ❌ WebRTC never connected — cannot test');
    await browser.close();
    return false;
  }
  console.log('  ✅ WebRTC connected, starting rapid Settings clicks...');

  // Wait a beat for stream to stabilise
  await new Promise(r => setTimeout(r, 2000));

  // Rapid left-click Settings → right-click dismiss, mirroring user's exact pattern
  let froze = false;
  for (let i = 0; i < RAPID_CYCLES; i++) {
    // Left-click Settings (opens settings menu)
    const lx = SETTINGS_BTN.x + rand(-15, 15);
    const ly = SETTINGS_BTN.y + rand(-10, 10);
    await page.mouse.click(lx, ly, { button: 'left' });
    console.log(`  [${i+1}/${RAPID_CYCLES}] L-click (${lx}, ${ly})`);

    await new Promise(r => setTimeout(r, rand(MIN_DELAY_MS, MAX_DELAY_MS)));

    // Right-click to dismiss (somewhere near the menu area, slight variation)
    const rx = SETTINGS_BTN.x + rand(-30, 30);
    const ry = SETTINGS_BTN.y + rand(20, 60);
    await page.mouse.click(rx, ry, { button: 'right' });
    console.log(`  [${i+1}/${RAPID_CYCLES}] R-click (${rx}, ${ry})`);

    await new Promise(r => setTimeout(r, rand(MIN_DELAY_MS, MAX_DELAY_MS)));

    // Check if the freeze overlay appeared
    const overlayVisible = await page.evaluate(() => {
      const overlay = document.querySelector('.backdrop-blur-sm');
      return !!overlay;
    });

    if (overlayVisible) {
      console.log(`\n  🔴 FREEZE REPRODUCED after ${i+1} cycles!`);
      console.log(`  The "CONNECTING WEBRTC P2P..." overlay is now permanent.`);
      froze = true;

      // Take screenshot
      const ts = Date.now();
      const path = `tests/freeze_repro_${label.replace(/\s/g, '_').toLowerCase()}_${ts}.png`;
      await page.screenshot({ path });
      console.log(`  Screenshot: ${path}`);

      // Dump relevant console logs
      const dcLogs = logs.filter(l =>
        l.includes('WebRTC') || l.includes('DataChannel') ||
        l.includes('closed') || l.includes('error') || l.includes('ice')
      );
      console.log('\n  --- Relevant console logs ---');
      dcLogs.forEach(l => console.log(`  ${l}`));
      break;
    }
  }

  if (!froze) {
    // Try a second pass — even faster, no delay between open/close
    console.log('\n  Pass 1 did not freeze. Trying burst mode (zero delay)...');
    for (let i = 0; i < 50; i++) {
      const lx = SETTINGS_BTN.x + rand(-10, 10);
      const ly = SETTINGS_BTN.y + rand(-5, 5);
      await page.mouse.click(lx, ly, { button: 'left' });
      // Immediate right-click
      await page.mouse.click(lx + rand(-20, 20), ly + rand(10, 40), { button: 'right' });

      if (i % 10 === 9) {
        const overlayVisible = await page.evaluate(() => !!document.querySelector('.backdrop-blur-sm'));
        if (overlayVisible) {
          console.log(`\n  🔴 FREEZE REPRODUCED in burst mode after ${i+1} cycles!`);
          const path = `tests/freeze_repro_burst_${label.replace(/\s/g, '_').toLowerCase()}.png`;
          await page.screenshot({ path });
          console.log(`  Screenshot: ${path}`);
          froze = true;
          break;
        }
      }
    }
  }

  if (!froze) {
    // Third pass — also mix in some other menu items to generate more screen changes
    console.log('\n  Burst mode did not freeze. Trying mixed menu clicks...');
    const MENU_ITEMS = [
      { x: 768, y: 501 },  // Create new world
      { x: 768, y: 540 },  // Object testing arena
      { x: 768, y: 579 },  // Settings
      { x: 768, y: 618 },  // About DF
    ];

    for (let i = 0; i < 80; i++) {
      const item = MENU_ITEMS[i % MENU_ITEMS.length];
      const lx = item.x + rand(-10, 10);
      const ly = item.y + rand(-5, 5);
      await page.mouse.click(lx, ly, { button: 'left' });
      await new Promise(r => setTimeout(r, rand(30, 100)));

      // Right-click to dismiss
      await page.mouse.click(lx + rand(-20, 20), ly + rand(20, 50), { button: 'right' });
      await new Promise(r => setTimeout(r, rand(30, 80)));

      if (i % 10 === 9) {
        const overlayVisible = await page.evaluate(() => !!document.querySelector('.backdrop-blur-sm'));
        if (overlayVisible) {
          console.log(`\n  🔴 FREEZE REPRODUCED in mixed mode after ${i+1} cycles!`);
          const path = `tests/freeze_repro_mixed_${label.replace(/\s/g, '_').toLowerCase()}.png`;
          await page.screenshot({ path });
          console.log(`  Screenshot: ${path}`);
          froze = true;
          break;
        }
      }
    }
  }

  if (!froze) {
    console.log(`\n  ⚠️  Could not reproduce freeze on ${label} after all passes.`);
    // Still take a screenshot for evidence
    const path = `tests/no_freeze_${label.replace(/\s/g, '_').toLowerCase()}.png`;
    await page.screenshot({ path });
    console.log(`  Screenshot: ${path}`);
  }

  // Wait 5s to let any delayed DC closure happen
  await new Promise(r => setTimeout(r, 5000));
  const finalOverlay = await page.evaluate(() => !!document.querySelector('.backdrop-blur-sm'));
  if (finalOverlay && !froze) {
    console.log(`\n  🔴 DELAYED FREEZE detected after waiting 5s!`);
    const path = `tests/freeze_repro_delayed_${label.replace(/\s/g, '_').toLowerCase()}.png`;
    await page.screenshot({ path });
  }

  await browser.close();
  return froze;
}

(async () => {
  let anyFroze = false;
  for (const target of URLS) {
    await resetSession();
    const froze = await testUrl(target);
    if (froze) anyFroze = true;
  }

  if (anyFroze) {
    console.log('\n✅ BUG REPRODUCED — freeze confirmed');
    process.exit(0);
  } else {
    console.log('\n❌ Could not reproduce freeze on either URL');
    process.exit(1);
  }
})();
