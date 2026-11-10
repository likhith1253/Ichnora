import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

export const CHROME_PATH = "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
export const BASE_URL = "http://localhost:3010";
export const SCREENSHOT_DIR = path.resolve(".qa_screenshots");

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

export async function launchBrowser(options = {}) {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      ...(options.args || [])
    ],
    ...options
  });
  return browser;
}

export function attachPageMonitors(page, testName = "test") {
  const consoleLogs = [];
  const consoleErrors = [];
  const networkFailures = [];
  const responses = [];

  page.on("console", (msg) => {
    const text = msg.text();
    const type = msg.type();
    consoleLogs.push({ type, text });
    if (type === "error" || type === "warning") {
      consoleErrors.push({ type, text });
    }
  });

  page.on("pageerror", (err) => {
    consoleErrors.push({ type: "pageerror", text: err.message || String(err) });
  });

  page.on("requestfailed", (req) => {
    networkFailures.push({
      url: req.url(),
      method: req.method(),
      failure: req.failure()?.errorText || "unknown"
    });
  });

  page.on("response", (res) => {
    if (res.status() >= 400) {
      responses.push({
        url: res.url(),
        status: res.status(),
        statusText: res.statusText()
      });
    }
  });

  return { consoleLogs, consoleErrors, networkFailures, responses };
}

export async function captureScreenshot(page, filename) {
  const filepath = path.join(SCREENSHOT_DIR, filename);
  await page.screenshot({ path: filepath, fullPage: true });
  return filepath;
}

