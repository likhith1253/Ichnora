import { launchBrowser, BASE_URL, attachPageMonitors, captureScreenshot } from "./helpers.mjs";
import assert from "node:assert";

async function run() {
  console.log("=== PHASE 2: TRY DEMO REAL BROWSER TESTS ===");
  const browser = await launchBrowser();
  const results = { passed: 0, failed: 0, defects: [] };

  try {
    const page = await browser.newPage();
    const monitors = attachPageMonitors(page, "2.0-demo");
    await page.setViewport({ width: 1440, height: 900 });

    // -------------------------------------------------------------
    // Test 2.1: Demo entry via Settings -> Try Demo
    // -------------------------------------------------------------
    console.log("--> Testing 2.1: Demo Entry");
    await page.goto(BASE_URL, { waitUntil: "networkidle0" });

    // Open "Your data" settings menu
    const settingsBtn = await page.$(".settings button");
    assert.ok(settingsBtn, "Settings button 'Your data' must exist");
    await settingsBtn.click();
    await page.waitForSelector("#privacy-menu", { timeout: 3000 });

    // Find "Try the demo" button
    const tryDemoBtn = await page.evaluateHandle(() => {
      const items = Array.from(document.querySelectorAll("#privacy-menu button"));
      return items.find(b => b.textContent?.includes("Try the demo"));
    });
    assert.ok(tryDemoBtn, "Try the demo button should be present in settings menu");
    await tryDemoBtn.click();

    // Wait for reload / navigation into demo
    await page.waitForSelector(".demo-bar", { timeout: 5000 });
    await captureScreenshot(page, "2.1-demo-entry.png");

    const demoBarText = await page.$eval(".demo-bar", el => el.textContent || "");
    console.log("    Demo bar text:", demoBarText);
    assert.ok(demoBarText.includes("Demo"), "Demo tag must be visible");
    assert.ok(demoBarText.includes("seeded example workspace"), "Must identify as seeded workspace");
    assert.ok(demoBarText.includes("live answers left"), "Must show turn budget");

    console.log("    [PASS] Test 2.1 Demo entry verified.");
    results.passed++;

    // -------------------------------------------------------------
    // Test 2.2: Seeded conversations, open loops and memory inspection
    // -------------------------------------------------------------
    console.log("--> Testing 2.2: Demo Seeded Content");
    
    // Check conversations in sidebar
    const convTitles = await page.$$eval(".conv-title", els => els.map(e => e.textContent?.trim()));
    console.log("    Seeded conversations:", convTitles);
    assert.ok(convTitles.length >= 3, `Expected at least 3 seeded conversations, got ${convTitles.length}`);
    assert.ok(convTitles.some(t => t.includes("CRM") || t.includes("crm")), "Expected CRM research conversation");
    assert.ok(convTitles.some(t => t.includes("Node") || t.includes("node") || t.includes("November") || t.includes("3 Nov")), "Expected 3 Nov question");

    // Check Open Loops view for seeded commitments/waiting/intentions
    const loopsTab = await page.$("#tab-loops");
    await loopsTab.click();
    await page.waitForSelector(".view", { timeout: 3000 });
    await captureScreenshot(page, "2.2-demo-open-loops.png");
    
    const loopsContent = await page.$eval(".view", el => el.textContent || "");
    assert.ok(loopsContent.includes("Commitments"), "Loops view should have Commitments section");
    assert.ok(loopsContent.includes("Waiting on others"), "Loops view should have Waiting section");
    assert.ok(loopsContent.includes("Tentative intentions"), "Loops view should have Tentative intentions section");
    console.log("    Loops view verified with Commitments, Waiting, Tentative intentions.");

    // Check Memory view for Decision history and preferences
    const memoryTab = await page.$("#tab-memory");
    await memoryTab.click();
    await page.waitForSelector(".view", { timeout: 3000 });
    await captureScreenshot(page, "2.2-demo-memory.png");

    const memoryContent = await page.$eval(".view", el => el.textContent || "");
    assert.ok(memoryContent.includes("PostgreSQL") || memoryContent.includes("Database") || memoryContent.includes("MongoDB"), "Memory should contain database decision history");
    console.log("    Memory view verified with Database decision history.");

    // Return to Chat tab
    const chatTab = await page.$("#tab-chat");
    await chatTab.click();
    await page.waitForSelector(".chat", { timeout: 3000 });

    console.log("    [PASS] Test 2.2 Demo seeded content verified.");
    results.passed++;

    // -------------------------------------------------------------
    // Test 2.3: Guided prompts
    // -------------------------------------------------------------
    console.log("--> Testing 2.3: Guided demo prompt interaction");
    // Click "New conversation" so welcome suggestions appear
    const newConvBtn = await page.$(".new-btn");
    await newConvBtn.click();
    await page.waitForSelector(".suggestions", { timeout: 3000 });

    const suggestionButtons = await page.$$(".suggestions button");
    console.log(`    Found ${suggestionButtons.length} guided demo suggestion buttons.`);
    assert.ok(suggestionButtons.length >= 4, "Expected at least 4 guided demo prompts");

    // Click the first prompt: "Recall by date" ("What did I ask you on 3 November?")
    const firstPrompt = suggestionButtons[0];
    const promptText = await firstPrompt.$eval("span:nth-child(2)", el => el.textContent?.trim());
    console.log("    Clicking guided prompt:", promptText);
    await firstPrompt.click();

    // Wait for the response to complete (pending phase indicator disappears and prose is filled)
    await page.waitForFunction(() => {
      const pendingEl = document.querySelector(".phase");
      const proseEls = Array.from(document.querySelectorAll(".msg.assistant .prose"));
      return !pendingEl && proseEls.some(el => (el.textContent || "").trim().length > 10);
    }, { timeout: 30000 });
    await captureScreenshot(page, "2.3-guided-prompt-response.png");

    const assistantText = await page.$$eval(".msg.assistant .prose", els => els.map(e => e.textContent).join(" "));
    console.log("    Assistant answer preview:", assistantText.slice(0, 150) + "...");
    assert.ok(assistantText.length > 20, "Assistant should provide a substantive answer");

    console.log("    [PASS] Test 2.3 Guided prompts verified.");
    results.passed++;

    // -------------------------------------------------------------
    // Test 2.4: Reset demo
    // -------------------------------------------------------------
    console.log("--> Testing 2.5: Reset demo lifecycle");
    const resetBtn = await page.evaluateHandle(() => {
      const btns = Array.from(document.querySelectorAll(".demo-actions button"));
      return btns.find(b => b.textContent?.includes("Reset demo"));
    });
    assert.ok(resetBtn, "Reset demo button should exist in demo bar");
    await resetBtn.click();

    // After reset, page reloads or refreshes state
    await page.waitForFunction(() => {
      const budget = document.querySelector(".demo-budget");
      return budget && budget.textContent?.includes("8 of 8");
    }, { timeout: 5000 });
    await captureScreenshot(page, "2.5-demo-reset.png");

    console.log("    [PASS] Test 2.5 Reset demo verified.");
    results.passed++;

    await page.close();
  } catch (err) {
    console.error("FAILED Phase 2 tests:", err);
    results.failed++;
    results.defects.push(err.message);
  } finally {
    await browser.close();
  }

  console.log(`\nPhase 2 Summary: ${results.passed} passed, ${results.failed} failed.`);
  return results;
}

run().then(res => {
  if (res.failed > 0) process.exit(1);
});
