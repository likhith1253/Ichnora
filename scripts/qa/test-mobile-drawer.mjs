import puppeteer from "puppeteer-core";
import path from "node:path";

const CHROME_PATH = "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
const BASE_URL = "http://localhost:3010";

async function testMobileDrawer() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu"]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 375, height: 812 });
    await page.goto(BASE_URL, { waitUntil: "networkidle2" });

    const menuBtnExists = await page.evaluate(() => {
      const btn = document.querySelector('button[aria-label="Open conversations"]');
      return !!btn;
    });
    console.log("Mobile menu button exists:", menuBtnExists);

    if (menuBtnExists) {
      await page.click('button[aria-label="Open conversations"]');
      await new Promise(r => setTimeout(r, 400));
      const railOpen = await page.evaluate(() => {
        const rail = document.querySelector(".rail");
        return {
          className: rail?.className,
          rect: rail?.getBoundingClientRect()
        };
      });
      console.log("Rail open state:", railOpen);
      await page.screenshot({ path: path.resolve(".qa_screenshots/06_mobile_drawer_open.png") });

      await page.click(".rail-close");
      await new Promise(r => setTimeout(r, 400));
      const railClosed = await page.evaluate(() => {
        const rail = document.querySelector(".rail");
        return {
          className: rail?.className,
          rect: rail?.getBoundingClientRect()
        };
      });
      console.log("Rail closed state:", railClosed);
      await page.screenshot({ path: path.resolve(".qa_screenshots/06_mobile_drawer_closed.png") });
    }
  } finally {
    await browser.close();
  }
}

testMobileDrawer();

