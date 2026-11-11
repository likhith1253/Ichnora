import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const CHROME_PATH = "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
const BASE_URL = "http://localhost:3010";
const SCREENSHOT_DIR = path.resolve(".qa_screenshots");

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

async function runQaSuite() {
  console.log("=== Starting Browser QA Suite for Ichnora ===");
  const results = {
    timestamp: new Date().toISOString(),
    browser: "Google Chrome",
    chromePath: CHROME_PATH,
    baseUrl: BASE_URL,
    steps: {},
    consoleErrors: [],
    consoleWarnings: [],
    hydrationErrors: [],
    networkFailures: [],
    responsiveResults: [],
    defects: [],
    passed: true
  };

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1440,900"
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    // Monitor console and network
    page.on("console", (msg) => {
      const type = msg.type();
      const text = msg.text();
      if (type === "error") {
        results.consoleErrors.push({ text, location: msg.location() });
        if (/hydrate|hydration|react-dom/i.test(text)) {
          results.hydrationErrors.push({ text, location: msg.location() });
        }
      } else if (type === "warning") {
        results.consoleWarnings.push({ text, location: msg.location() });
        if (/hydrate|hydration/i.test(text)) {
          results.hydrationErrors.push({ text, location: msg.location() });
        }
      }
    });

    page.on("pageerror", (err) => {
      const text = err.message || String(err);
      results.consoleErrors.push({ type: "pageerror", text });
      if (/hydrate|hydration/i.test(text)) {
        results.hydrationErrors.push({ type: "pageerror", text });
      }
    });

    page.on("requestfailed", (req) => {
      results.networkFailures.push({
        url: req.url(),
        method: req.method(),
        failure: req.failure()?.errorText || "unknown"
      });
    });

    page.on("response", (res) => {
      if (res.status() >= 400) {
        results.networkFailures.push({
          url: res.url(),
          status: res.status(),
          statusText: res.statusText()
        });
      }
    });

    // ==========================================
    // STEP 1 & 2: Inspect Initial Screen
    // ==========================================
    console.log("\n[STEP 1 & 2] Loading initial page at", BASE_URL);
    const navResponse = await page.goto(BASE_URL, { waitUntil: "networkidle2", timeout: 15000 });
    const initialStatus = navResponse ? navResponse.status() : null;
    await page.waitForSelector("body", { timeout: 5000 });
    // Allow React hydration to complete
    await new Promise((r) => setTimeout(r, 1000));

    const initialInfo = await page.evaluate(() => {
      const title = document.title;
      const brand = document.querySelector(".brand-name")?.textContent?.trim() || null;
      const tabs = Array.from(document.querySelectorAll(".tab-bar button, [role='tab']")).map(b => b.textContent?.trim());
      const hasComposer = !!document.querySelector("textarea");
      const hasSendBtn = !!document.querySelector("button[type='submit'], .send-btn, form button");
      const railVisible = !!document.querySelector(".rail");
      return { title, brand, tabs, hasComposer, hasSendBtn, railVisible };
    });

    results.steps.initialScreen = {
      httpStatus: initialStatus,
      info: initialInfo,
      screenshot: "01_initial_screen.png"
    };
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "01_initial_screen.png"), fullPage: true });
    console.log("Initial Screen Info:", JSON.stringify(initialInfo, null, 2));

    // ==========================================
    // STEP 3: Navigation Test (Chat, Loops, Memory)
    // ==========================================
    console.log("\n[STEP 3] Testing Navigation between views...");

    // Click "Open loops" tab
    const openLoopsClicked = await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll("button, [role='tab']"));
      const loopBtn = tabs.find(b => /open loops/i.test(b.textContent || ""));
      if (loopBtn) {
        loopBtn.click();
        return true;
      }
      return false;
    });
    await new Promise((r) => setTimeout(r, 500));
    const loopsViewCheck = await page.evaluate(() => {
      const activeTab = document.querySelector("[role='tab'][aria-selected='true'], .tab.active, button.active")?.textContent?.trim();
      const hasView = !!document.querySelector(".view, .view-head");
      const heading = document.querySelector("h1, h2")?.textContent?.trim();
      const pageText = document.body.innerText;
      return { activeTab, hasView, heading, snippet: pageText.slice(0, 300).replace(/\n+/g, " ") };
    });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "02_open_loops_view.png"), fullPage: true });

    // Click "Memory" tab
    const memoryClicked = await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll("button, [role='tab']"));
      const memBtn = tabs.find(b => /^memory$/i.test((b.textContent || "").trim()));
      if (memBtn) {
        memBtn.click();
        return true;
      }
      return false;
    });
    await new Promise((r) => setTimeout(r, 500));
    const memoryViewCheck = await page.evaluate(() => {
      const activeTab = document.querySelector("[role='tab'][aria-selected='true'], .tab.active, button.active")?.textContent?.trim();
      const hasView = !!document.querySelector(".view, .view-head");
      const searchInput = !!document.querySelector("input[type='search'], input[placeholder*='Search' i]");
      const pageText = document.body.innerText;
      return { activeTab, hasView, searchInput, snippet: pageText.slice(0, 300).replace(/\n+/g, " ") };
    });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "03_memory_view.png"), fullPage: true });

    // Click back to "Chat" tab
    const chatClicked = await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll("button, [role='tab']"));
      const chatBtn = tabs.find(b => /^chat$/i.test((b.textContent || "").trim()));
      if (chatBtn) {
        chatBtn.click();
        return true;
      }
      return false;
    });
    await new Promise((r) => setTimeout(r, 500));
    const chatViewCheck = await page.evaluate(() => {
      const activeTab = document.querySelector("[role='tab'][aria-selected='true'], .tab.active, button.active")?.textContent?.trim();
      const hasComposer = !!document.querySelector("textarea");
      return { activeTab, hasComposer };
    });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "04_back_to_chat.png"), fullPage: true });

    results.steps.navigation = {
      openLoops: { clicked: openLoopsClicked, ...loopsViewCheck, screenshot: "02_open_loops_view.png" },
      memory: { clicked: memoryClicked, ...memoryViewCheck, screenshot: "03_memory_view.png" },
      chat: { clicked: chatClicked, ...chatViewCheck, screenshot: "04_back_to_chat.png" }
    };
    console.log("Navigation results:", JSON.stringify(results.steps.navigation, null, 2));

    // ==========================================
    // STEP 4: Creating new conversation & typing message
    // ==========================================
    console.log("\n[STEP 4] Testing conversation creation & typing message...");

    // Click "New conversation"
    const newConvClicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const btn = buttons.find(b => /new conversation/i.test(b.textContent || ""));
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });

    await new Promise((r) => setTimeout(r, 400));

    // Type a message into textarea
    const messageText = "Hello Ichnora, this is an automated QA test message.";
    const textareaExists = await page.$("textarea");
    let typingSuccess = false;
    let sendButtonInfo = null;

    if (textareaExists) {
      await page.focus("textarea");
      await page.keyboard.type(messageText);
      typingSuccess = true;

      sendButtonInfo = await page.evaluate(() => {
        const btn = document.querySelector("button[type='submit'], .send-btn, form button");
        return {
          exists: !!btn,
          disabled: btn ? btn.disabled : null,
          ariaLabel: btn?.getAttribute("aria-label") || btn?.textContent?.trim()
        };
      });

      // Submit message
      await page.keyboard.press("Enter");
      await new Promise((r) => setTimeout(r, 2000)); // wait for response/pending state
    }

    const conversationPostCheck = await page.evaluate(() => {
      const messages = Array.from(document.querySelectorAll(".message, .msg, [data-role], .user-message, .bubble")).map(m => ({
        role: m.getAttribute("data-role") || m.className,
        text: m.textContent?.trim().slice(0, 150)
      }));
      const pendingIndicator = !!document.querySelector(".phase, .pending, [role='status'], .spinner, .phase-indicator");
      const errorBox = document.querySelector(".error, .chat-error, .alert, [role='alert']")?.textContent?.trim() || null;
      return { messagesCount: messages.length, messages, pendingIndicator, errorBox };
    });

    results.steps.conversation = {
      newConversationClicked: newConvClicked,
      typedMessage: messageText,
      typingSuccess,
      sendButtonInfo,
      result: conversationPostCheck,
      screenshot: "05_conversation_sent.png"
    };
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "05_conversation_sent.png"), fullPage: true });
    console.log("Conversation result:", JSON.stringify(results.steps.conversation, null, 2));

    // ==========================================
    // STEP 5: Responsive Viewports Test
    // ==========================================
    console.log("\n[STEP 5] Testing responsive viewports...");
    const viewports = [
      { width: 1440, height: 900, name: "desktop-1440x900" },
      { width: 1366, height: 768, name: "desktop-1366x768" },
      { width: 768, height: 1024, name: "tablet-768x1024" },
      { width: 375, height: 812, name: "mobile-375x812" },
      { width: 320, height: 700, name: "mobile-320x700" }
    ];

    for (const vp of viewports) {
      await page.setViewport({ width: vp.width, height: vp.height });
      await new Promise((r) => setTimeout(r, 500));

      const overflowCheck = await page.evaluate((vw) => {
        const docEl = document.documentElement;
        const body = document.body;
        const scrollWidth = Math.max(docEl.scrollWidth, body.scrollWidth);
        const clientWidth = docEl.clientWidth;
        const hasHorizontalOverflow = scrollWidth > clientWidth + 1; // 1px threshold

        const overflowingElements = [];
        const all = document.querySelectorAll("*");
        for (const el of all) {
          const rect = el.getBoundingClientRect();
          // Elements projecting beyond viewport right
          if (rect.right > window.innerWidth + 1) {
            const style = window.getComputedStyle(el);
            if (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              parseFloat(style.opacity || "1") > 0 &&
              rect.width > 0 &&
              rect.height > 0
            ) {
              overflowingElements.push({
                tag: el.tagName.toLowerCase(),
                className: (el.className || "").toString().slice(0, 100),
                right: Math.round(rect.right),
                diff: Math.round(rect.right - window.innerWidth)
              });
            }
          }
        }

        // Check if hamburger / toggle button exists on small screen
        const menuBtn = !!document.querySelector("button[aria-label*='menu' i], .menu-btn, .rail-open");

        return {
          viewportWidth: window.innerWidth,
          scrollWidth,
          clientWidth,
          hasHorizontalOverflow,
          overflowingElements: overflowingElements.slice(0, 5),
          hasMenuButton: menuBtn
        };
      }, vp.width);

      const shotName = `06_viewport_${vp.width}x${vp.height}.png`;
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, shotName), fullPage: false });

      results.responsiveResults.push({
        viewport: `${vp.width}x${vp.height}`,
        ...overflowCheck,
        screenshot: shotName
      });

      console.log(`Viewport ${vp.width}x${vp.height}: overflow=${overflowCheck.hasHorizontalOverflow}, scrollWidth=${overflowCheck.scrollWidth}, clientWidth=${overflowCheck.clientWidth}`);
      if (overflowCheck.hasHorizontalOverflow) {
        results.defects.push({
          type: "responsive_overflow",
          viewport: `${vp.width}x${vp.height}`,
          details: overflowCheck
        });
      }
    }

    // Reset back to desktop viewport
    await page.setViewport({ width: 1440, height: 900 });
    await new Promise((r) => setTimeout(r, 500));

    // ==========================================
    // STEP 6: Try Demo Flow
    // ==========================================
    console.log("\n[STEP 6] Testing 'Try Demo' flow...");

    // Click "Your data" dropdown to find "Try the demo"
    const openYourData = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const btn = buttons.find(b => /your data/i.test(b.textContent || ""));
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });

    await new Promise((r) => setTimeout(r, 500));

    const tryDemoClicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button, a"));
      const btn = buttons.find(b => /try the demo|try demo/i.test(b.textContent || ""));
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });

    console.log(`'Your data' clicked: ${openYourData}, 'Try Demo' clicked: ${tryDemoClicked}`);

    // Wait for demo workspace to load (page navigation or re-render)
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 10000 }).catch(() => null);
    await new Promise((r) => setTimeout(r, 2000));

    // Verify Demo State:
    // 1. Demo Workspace Banner (.demo-bar)
    // 2. Seeded conversations in sidebar
    // 3. Guided prompts in ChatView
    const demoChatCheck = await page.evaluate(() => {
      const demoBar = document.querySelector(".demo-bar, [role='status'].demo-bar");
      const demoTag = document.querySelector(".demo-tag")?.textContent?.trim();
      const demoBarText = demoBar?.textContent?.trim();
      const budgetText = document.querySelector(".demo-budget")?.textContent?.trim();
      const allButtons = Array.from(document.querySelectorAll("button"));
      const resetButton = !!allButtons.find(b => /reset demo/i.test(b.textContent || ""));

      // Sidebar conversations
      const convItems = Array.from(document.querySelectorAll(".conv-title, .conv-main")).map(c => c.textContent?.trim());

      // Guided prompts
      const prompts = Array.from(document.querySelectorAll(".sugg, .suggestion, .demo-prompt, .prompt-chip, button")).filter(el => {
        const text = el.textContent || "";
        return /recall by date|is it still true|has any of it changed|open loops|decision history/i.test(text);
      }).map(p => ({
        text: p.textContent?.trim()
      }));

      return {
        hasDemoBar: !!demoBar,
        demoTag,
        demoBarText,
        budgetText,
        hasResetButton: resetButton,
        conversationsCount: convItems.length,
        conversations: convItems,
        guidedPromptsCount: prompts.length,
        guidedPrompts: prompts
      };
    });

    results.steps.demoFlow = {
      chat: demoChatCheck,
      screenshotChat: "07_demo_chat_with_banner.png"
    };
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "07_demo_chat_with_banner.png"), fullPage: true });
    console.log("Demo Chat Check:", JSON.stringify(demoChatCheck, null, 2));

    // Verify Open Loops in Demo Workspace
    console.log("Navigating to Open Loops in Demo Workspace...");
    await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll("button, [role='tab']"));
      const loopBtn = tabs.find(b => /open loops/i.test(b.textContent || ""));
      loopBtn?.click();
    });
    await new Promise((r) => setTimeout(r, 1000));

    const demoLoopsCheck = await page.evaluate(() => {
      const groupHeaders = Array.from(document.querySelectorAll(".group-head, h2")).map(h => h.textContent?.trim());
      const loopItems = Array.from(document.querySelectorAll(".item-card, .personal-item, .card, li")).map(el => el.textContent?.trim().slice(0, 100));
      const summary = document.querySelector(".summary")?.textContent?.trim();
      const text = document.body.innerText;
      return {
        summary,
        groupHeaders,
        loopsCount: loopItems.length,
        itemsSnippet: loopItems.slice(0, 10),
        bodySnippet: text.slice(0, 400).replace(/\n+/g, " ")
      };
    });
    results.steps.demoFlow.openLoops = {
      ...demoLoopsCheck,
      screenshot: "08_demo_open_loops.png"
    };
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "08_demo_open_loops.png"), fullPage: true });
    console.log("Demo Open Loops Check:", JSON.stringify(demoLoopsCheck, null, 2));

    // Verify Memory in Demo Workspace
    console.log("Navigating to Memory in Demo Workspace...");
    await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll("button, [role='tab']"));
      const memBtn = tabs.find(b => /^memory$/i.test((b.textContent || "").trim()));
      memBtn?.click();
    });
    await new Promise((r) => setTimeout(r, 1000));

    const demoMemoryCheck = await page.evaluate(() => {
      const memoryItems = Array.from(document.querySelectorAll(".item-card, .personal-item, .memory-item, .card, li")).map(el => el.textContent?.trim().slice(0, 100));
      const searchInput = !!document.querySelector("input[type='search'], input[placeholder*='search' i]");
      const text = document.body.innerText;
      return {
        memoryCount: memoryItems.length,
        itemsSnippet: memoryItems.slice(0, 10),
        searchInput,
        bodySnippet: text.slice(0, 400).replace(/\n+/g, " ")
      };
    });
    results.steps.demoFlow.memory = {
      ...demoMemoryCheck,
      screenshot: "09_demo_memory.png"
    };
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "09_demo_memory.png"), fullPage: true });
    console.log("Demo Memory Check:", JSON.stringify(demoMemoryCheck, null, 2));

    // Check for any hydration defects
    if (results.hydrationErrors.length > 0) {
      results.defects.push({
        type: "hydration_error",
        details: results.hydrationErrors
      });
    }

    // Check console errors
    const seriousConsoleErrors = results.consoleErrors.filter(e =>
      !/favicon/i.test(e.text || "")
    );
    if (seriousConsoleErrors.length > 0) {
      results.defects.push({
        type: "console_errors",
        details: seriousConsoleErrors
      });
    }

    results.passed = results.defects.length === 0;

  } catch (err) {
    console.error("Test execution failed:", err);
    results.defects.push({
      type: "fatal_error",
      message: err.message,
      stack: err.stack
    });
    results.passed = false;
  } finally {
    await browser.close();
  }

  const reportPath = path.resolve("qa_browser_report.json");
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2), "utf8");
  console.log(`\n=== QA Suite Finished! Report written to ${reportPath} ===`);
  console.log(`Defects found: ${results.defects.length}`);
}

runQaSuite();
