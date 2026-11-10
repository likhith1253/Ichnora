import { launchBrowser, BASE_URL, attachPageMonitors, captureScreenshot } from "./helpers.mjs";
import assert from "node:assert";

async function run() {
  console.log("=== PHASE 1: LOCAL MODE REAL BROWSER TESTS ===");
  const browser = await launchBrowser();
  const results = { passed: 0, failed: 0, defects: [] };

  try {
    // -------------------------------------------------------------
    // Test 1.1: Initial launch
    // -------------------------------------------------------------
    console.log("--> Testing 1.1: Initial launch");
    const page1 = await browser.newPage();
    const monitors1 = attachPageMonitors(page1, "1.1-launch");
    await page1.setViewport({ width: 1440, height: 900 });

    const response = await page1.goto(BASE_URL, { waitUntil: "networkidle0" });
    assert.strictEqual(response.status(), 200, "Root page must return 200");
    await captureScreenshot(page1, "1.1-initial-launch.png");

    // Check no unexpected redirects
    const finalUrl = page1.url();
    assert.strictEqual(finalUrl, `${BASE_URL}/`, `Should remain on root URL, got ${finalUrl}`);

    // Check no sign-in required, no sign-in modal/redirect
    const bodyText = await page1.evaluate(() => document.body.innerText);
    assert.ok(!bodyText.includes("Sign in to keep your work"), "Should not show signin screen in LOCAL mode");

    // Check brand and chat view presence
    const brand = await page1.$(".brand-name");
    assert.ok(brand, "Brand name should be present");

    // Check rail / sidebar status
    const railFoot = await page1.evaluate(() => document.querySelector(".rail-foot")?.textContent || "");
    console.log("    Status in rail foot:", railFoot.trim());
    assert.ok(railFoot.includes("openai/gpt-oss-120b") || railFoot.includes("Model ready") || railFoot.includes("not set"), "Should show model status");

    // Check views navigation tabs: Chat, Open loops, Memory
    const tabs = await page1.$$(".tabs .tab");
    assert.strictEqual(tabs.length, 3, "Expected 3 view tabs (Chat, Open loops, Memory)");

    // Check console errors
    console.log("    Failed responses on initial launch:", monitors1.responses);
    const seriousResponses = monitors1.responses.filter(r => !r.url.endsWith("favicon.ico"));
    assert.strictEqual(seriousResponses.length, 0, "No failed non-favicon HTTP responses on initial launch");
    const seriousErrors = monitors1.consoleErrors.filter(e => 
      !e.text.includes("favicon") && 
      !e.text.includes("Download the React DevTools") &&
      !e.text.includes("404")
    );
    assert.strictEqual(seriousErrors.filter(e => e.type === "error" || e.type === "pageerror").length, 0, "No serious console errors");

    console.log("    [PASS] Test 1.1 Initial launch verified.");
    results.passed++;

    // -------------------------------------------------------------
    // Test 1.2: Workspace creation and persistence
    // -------------------------------------------------------------
    console.log("--> Testing 1.2: Workspace persistence across reloads and tabs");
    const initialWs = await page1.evaluate(() => localStorage.getItem("minimi.workspace"));
    assert.ok(initialWs, "A workspace id must be generated and stored in localStorage");
    console.log("    Generated workspace ID:", initialWs);

    // Reload the page
    await page1.reload({ waitUntil: "networkidle0" });
    const reloadedWs = await page1.evaluate(() => localStorage.getItem("minimi.workspace"));
    assert.strictEqual(reloadedWs, initialWs, "Workspace ID must remain identical after reload");

    // Open a second tab
    const page2 = await browser.newPage();
    await page2.goto(BASE_URL, { waitUntil: "networkidle0" });
    const secondTabWs = await page2.evaluate(() => localStorage.getItem("minimi.workspace"));
    assert.strictEqual(secondTabWs, initialWs, "Second tab must share the same workspace ID");
    await page2.close();

    console.log("    [PASS] Test 1.2 Workspace persistence verified.");
    results.passed++;

    // -------------------------------------------------------------
    // Test 1.3: Navigation & UI Controls (Enter vs Shift+Enter, empty submit)
    // -------------------------------------------------------------
    console.log("--> Testing 1.3: Input behavior and Chat UI interactions");
    const textareaSelector = "textarea#prompt";
    await page1.waitForSelector(textareaSelector);

    // Empty message submit attempt (pressing Enter on empty textarea)
    await page1.focus(textareaSelector);
    await page1.keyboard.press("Enter");
    const messagesCountAfterEmpty = await page1.$$eval(".msg", ms => ms.length);
    assert.strictEqual(messagesCountAfterEmpty, 0, "Empty message should not be sent");

    // Shift+Enter should insert newline
    await page1.type(textareaSelector, "First line");
    await page1.keyboard.down("Shift");
    await page1.keyboard.press("Enter");
    await page1.keyboard.up("Shift");
    await page1.type(textareaSelector, "Second line");
    const textVal = await page1.$eval(textareaSelector, el => el.value);
    assert.ok(textVal.includes("\n"), "Shift+Enter should insert newline");

    // Clear textarea
    await page1.evaluate(sel => { document.querySelector(sel).value = ""; }, textareaSelector);

    console.log("    [PASS] Test 1.3 Chat input behavior verified.");
    results.passed++;

    // -------------------------------------------------------------
    // Test 1.4: Navigation between Chat, Open loops, and Memory
    // -------------------------------------------------------------
    console.log("--> Testing 1.4: View switching (Chat <-> Open loops <-> Memory)");
    
    // Switch to Open loops
    const loopsTab = await page1.$("#tab-loops");
    assert.ok(loopsTab, "Loops tab must exist");
    await loopsTab.click();
    await page1.waitForSelector(".view", { timeout: 3000 });
    const loopsText = await page1.evaluate(() => document.querySelector(".view")?.textContent || "");
    assert.ok(loopsText.includes("Nothing open") || loopsText.includes("Open loops") || loopsText.includes("Commitments"), "Loops view loaded properly");
    await captureScreenshot(page1, "1.4-open-loops-empty.png");

    // Switch to Memory
    const memoryTab = await page1.$("#tab-memory");
    assert.ok(memoryTab, "Memory tab must exist");
    await memoryTab.click();
    await page1.waitForSelector(".view", { timeout: 3000 });
    const memoryText = await page1.evaluate(() => document.querySelector(".view")?.textContent || "");
    assert.ok(memoryText.includes("Memory") || memoryText.includes("Decisions"), "Memory view loaded properly");
    await captureScreenshot(page1, "1.4-memory-empty.png");

    // Switch back to Chat
    const chatTab = await page1.$("#tab-chat");
    assert.ok(chatTab, "Chat tab must exist");
    await chatTab.click();
    await page1.waitForSelector(".chat", { timeout: 3000 });

    console.log("    [PASS] Test 1.4 Navigation between views verified.");
    results.passed++;

    await page1.close();
  } catch (err) {
    console.error("FAILED Phase 1 tests:", err);
    results.failed++;
    results.defects.push(err.message);
  } finally {
    await browser.close();
  }

  console.log(`\nPhase 1 Summary: ${results.passed} passed, ${results.failed} failed.`);
  return results;
}

run().then(res => {
  if (res.failed > 0) process.exit(1);
});
