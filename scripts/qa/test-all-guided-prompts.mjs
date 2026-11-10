import { launchBrowser, BASE_URL, captureScreenshot } from "./helpers.mjs";
import assert from "node:assert";

async function run() {
  console.log("=== TESTING ALL 5 GUIDED PROMPTS IN DEMO ===");
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    // Open demo workspace
    await page.goto(BASE_URL, { waitUntil: "networkidle0" });
    const isDemo = await page.$(".demo-bar");
    if (!isDemo) {
      await page.click(".settings button");
      await page.waitForSelector("#privacy-menu", { timeout: 3000 });
      const tryDemoBtn = await page.evaluateHandle(() => {
        const items = Array.from(document.querySelectorAll("#privacy-menu button"));
        return items.find(b => b.textContent?.includes("Try the demo"));
      });
      await tryDemoBtn.click();
      await page.waitForSelector(".demo-bar", { timeout: 10000 });
    }

    // Reset demo first to have fresh 8 of 8 budget
    const resetBtn = await page.evaluateHandle(() => {
      const btns = Array.from(document.querySelectorAll(".demo-actions button"));
      return btns.find(b => b.textContent?.includes("Reset demo"));
    });
    if (resetBtn) await resetBtn.click();
    await page.waitForFunction(() => document.querySelector(".demo-budget")?.textContent?.includes("8 of 8"), { timeout: 5000 });

    const promptResults = [];

    // Prompt indices: 0 to 4
    for (let i = 0; i < 5; i++) {
      console.log(`\n--> Testing Guided Prompt #${i + 1}`);
      // Click New Conversation so suggestions are visible
      await page.click(".new-btn");
      await page.waitForSelector(".suggestions button", { timeout: 4000 });

      const buttons = await page.$$(".suggestions button");
      const targetBtn = buttons[i];
      assert.ok(targetBtn, `Button for prompt #${i+1} must exist`);

      const label = await targetBtn.$eval(".sg-label", el => el.textContent?.trim());
      const promptText = await targetBtn.$eval("span:nth-child(2)", el => el.textContent?.trim());
      console.log(`    [Prompt #${i+1}] Label: "${label}" | Text: "${promptText}"`);

      // Record budget before click
      const budgetBefore = await page.$eval(".demo-budget", el => el.textContent || "");

      // Click guided prompt
      await targetBtn.click();

      // Wait for stream to finish
      await page.waitForFunction(() => {
        const pendingEl = document.querySelector(".phase");
        const proseEls = Array.from(document.querySelectorAll(".msg.assistant .prose"));
        return !pendingEl && proseEls.length > 0;
      }, { timeout: 35000 });

      const budgetAfter = await page.$eval(".demo-budget", el => el.textContent || "");
      const answer = await page.$eval(".msg.assistant:last-of-type .prose", el => el.textContent?.trim() || "");

      console.log(`    Budget: "${budgetBefore}" -> "${budgetAfter}"`);
      console.log(`    Answer preview (length ${answer.length}):`, answer.slice(0, 140) + "...");
      assert.ok(answer.length > 30, `Answer for "${label}" must be substantial`);

      await captureScreenshot(page, `guided-prompt-${i + 1}-${label.toLowerCase().replace(/\\s+/g, '-')}.png`);

      promptResults.push({
        index: i + 1,
        label,
        promptText,
        budgetBefore,
        budgetAfter,
        answerLength: answer.length
      });
    }

    console.log("\nAll 5 guided prompts executed successfully!");
    console.table(promptResults);
    await page.close();
  } finally {
    await browser.close();
  }
}

run().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
