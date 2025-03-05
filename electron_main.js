// main.js

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');
const HEADLESS_BIDDING = false;   // Bidding in non-headless
const HEADLESS_EXTRACTION = true; // Extraction in headless


/** We'll define a "credentials.json" in the userData path. */
function getCredentialsFilePath() {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'credentials.json');
}

function loadData() {
  const filePath = getCredentialsFilePath();
  console.log('[IO] loadData =>', filePath);
  try {
    if (!fs.existsSync(filePath)) {
      const defaultData = { credentials: [], auctions: [] };
      fs.writeFileSync(filePath, JSON.stringify(defaultData, null, 2), 'utf8');
      return defaultData;
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      credentials: parsed.credentials || [],
      auctions: parsed.auctions || [],
    };
  } catch (err) {
    console.error('[IO] loadData error =>', err);
    return { credentials: [], auctions: [] };
  }
}

function saveData({ credentials, auctions }) {
  const filePath = getCredentialsFilePath();
  console.log('[IO] saveData =>', filePath);
  try {
    fs.writeFileSync(filePath, JSON.stringify({ credentials, auctions }, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[IO] saveData error =>', err);
    return false;
  }
}

function createWindow() {
  console.log('[App] createWindow()');
  try {
    const win = new BrowserWindow({
      width: 1000,
      height: 700,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        spellcheck: false
      },
    });
    win.loadFile('index.html');
    console.log('[App] Main window created & loaded');
  } catch (err) {
    console.error('[App] Error in createWindow =>', err);
  }
}

app.whenReady().then(() => {
  console.log('[App] app.whenReady()');
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  console.log('[App] window-all-closed');
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

/* ====================== DIALOG IPC: show-dialog ======================
   We'll handle asynchronous message boxes for the renderer. */
ipcMain.handle('show-dialog', async (event, options) => {
  // example options => { type, title, message, buttons }
  const result = await dialog.showMessageBox({
    type: options.type || 'info',
    title: options.title || 'Message',
    message: options.message || '',
    buttons: options.buttons || ['OK'],
    noLink: true, // avoids Windows linking?
    cancelId: options.buttons ? options.buttons.length - 1 : 0
  });
  return result; // includes { response, checkboxChecked }
});

/* ====================== CSV or Time Helpers ====================== */
function convertAuctionDate(original) {
  const dt = new Date(original);
  if (isNaN(dt.getTime())) return '';
  dt.setHours(dt.getHours() + 1);
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  const yyyy = dt.getFullYear();
  const hh = String(dt.getHours()).padStart(2, '0');
  const min = String(dt.getMinutes()).padStart(2, '0');
  return `${mm}/${dd}/${yyyy} ${hh}:${min}`;
}

function convertCivicSourceUrlToIdAuction(fullUrl) {
  if (!fullUrl.startsWith('https://www.civicsource.com/')) return '';
  const remainder = fullUrl.replace('https://www.civicsource.com/', '').trim();
  if (remainder.length < 4) return remainder.toLowerCase();
  const prefix = remainder.substring(0, 3).toLowerCase();
  const suffix = remainder.substring(3);
  return `${prefix}/${suffix}`;
}

/* ====================== BIDDING LOGIC ====================== */
const browserMap = {};
const bidTimeouts = [];

async function ensureLoggedIn(username, password, page) {
  if (browserMap[username].isLoggedIn) {
    console.log(`[Bidding] ${username} is already logged in => skip login`);
    return;
  }
  try {
    console.log(`[Bidding] Logging in => ${username}`);
    await page.setDefaultNavigationTimeout(60000);
    await page.setDefaultTimeout(60000);

    await page.goto('https://www.civicsource.com/login/', { waitUntil: 'networkidle2' });
    await page.waitForSelector('input[name="username"]', { timeout: 20000 });
    await page.type('input[name="username"]', username);

    await page.waitForSelector('input[name="password"]', { timeout: 20000 });
    await page.type('input[name="password"]', password);

    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2' }),
    ]);
    console.log(`[Bidding] Login successful for ${username}`);
    browserMap[username].isLoggedIn = true;
  } catch (err) {
    console.error(`[Bidding] Error logging in for ${username}:`, err);
  }
}

async function placeBid(auction, page) {
  console.log(`[Bidding] placeBid => ${auction.idAuction}`);
  try {
    await page.setDefaultTimeout(60000);
    await page.setDefaultNavigationTimeout(60000);

    const url = `https://www.civicsource.com/auctions/${auction.idAuction}`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    const inputId = auction.idAuction.toUpperCase().replace(/\//g, '') + '-place-bid-input';
    const placeBidSelector = `#${inputId}`;
    const newBid = parseFloat(auction.bidProxy) || 0;

    console.log(`[Bidding] Typing $${newBid.toFixed(2)} => ${placeBidSelector}`);
    await page.waitForSelector(placeBidSelector, { timeout: 20000 });
    await page.click(placeBidSelector, { clickCount: 3 });
    await page.type(placeBidSelector, newBid.toFixed(2));

    const firstBtnSel = 'button[type="submit"] span[title="Place Bid"]';
    await page.waitForSelector(firstBtnSel, { timeout: 15000 });
    await page.click(firstBtnSel);
    console.log('[Bidding] Clicked FIRST "Place Bid". Wait 3s...');
    await new Promise(r => setTimeout(r, 3000));

    const secondBtnSel = 'div.text-center button[type="submit"]';
    await page.waitForSelector(secondBtnSel, { timeout: 15000 });
    await page.click(secondBtnSel);
    console.log('[Bidding] Clicked SECOND "Place Bid".');

    // Mark bidPlaced in JSON
    const { credentials, auctions } = loadData();
    const nowStr = new Date().toLocaleString();
    auction.bidPlaced = nowStr;
    const idx = auctions.findIndex(a => a.id === auction.id);
    if (idx > -1) {
      auctions[idx].bidPlaced = nowStr;
      saveData({ credentials, auctions });
    }
  } catch (err) {
    console.error('[Bidding] placeBid error =>', err);
  }
}
async function handleUserBids(cred, userAuctions) {
  // Filter out auctions that have a bidProxy of 0 so we don't even attempt a login or bid.
  const auctionsToBid = userAuctions.filter(a => parseFloat(a.bidProxy) > 0);

  // If there are no auctions with a positive bidProxy, skip the rest entirely.
  if (!auctionsToBid.length) {
    console.log(`[Bidding] Skipping ${cred.username} => all auctions are 0 or no valid bids.`);
    return;
  }

  const { username, password } = cred;
  if (!browserMap[username]) {
    const br = await puppeteer.launch({ headless: HEADLESS_BIDDING});
    const pg = await br.newPage();
    browserMap[username] = { browser: br, page: pg, isLoggedIn: false };
  }
  const { page } = browserMap[username];

  // First ensure we're logged in (only once).
  await ensureLoggedIn(username, password, page);

  for (const auction of auctionsToBid) {
    // timeToBid check
    if (!auction.timeToBid) {
      console.log(`[Bidding] Auction ${auction.idAuction} => no time => skip`);
      continue;
    }

    const targetTime = new Date(auction.timeToBid);
    const now = Date.now();
    const diff = targetTime - now;

    if (diff <= 0) {
      // place immediately
      await placeBid(auction, page);
    } else {
      console.log(`[Bidding] Scheduling => ${auction.idAuction} in ${diff}ms`);
      const timeoutId = setTimeout(async () => {
        await placeBid(auction, page);
      }, diff);
      bidTimeouts.push({ timeoutId, auctionId: auction.id, username });
    }
  }
}


/* ====================== IPC: Credentials & Auctions ====================== */
ipcMain.handle('get-credentials', () => {
  console.log('[IPC] get-credentials');
  const { credentials } = loadData();
  return credentials;
});

ipcMain.handle('save-credentials', (event, updatedCreds) => {
  console.log('[IPC] save-credentials');
  const { credentials, auctions } = loadData();
  return saveData({ credentials: updatedCreds, auctions });
});

ipcMain.handle('get-auctions', () => {
  console.log('[IPC] get-auctions');
  const { auctions } = loadData();
  return auctions;
});

ipcMain.handle('save-auctions', (event, updatedAuctions) => {
  console.log('[IPC] save-auctions');
  const { credentials, auctions } = loadData();
  return saveData({ credentials, auctions: updatedAuctions });
});

/* ====================== Bidding: fetch-auctions-data ====================== */
ipcMain.handle('fetch-auctions-data', async () => {
  console.log('[IPC] fetch-auctions-data => clearing old timers...');
  for (const t of bidTimeouts) {
    clearTimeout(t.timeoutId);
  }
  bidTimeouts.length = 0;

  const { credentials, auctions } = loadData();
  if (!credentials.length || !auctions.length) {
    console.log('[Bidding] No creds or auctions => returning');
    return auctions;
  }

  const auctionsByAccount = {};
  for (const auc of auctions) {
    if (!auc.account) continue;
    if (!auctionsByAccount[auc.account]) auctionsByAccount[auc.account] = [];
    auctionsByAccount[auc.account].push(auc);
  }

  const tasks = [];
  for (const cred of credentials) {
    const userAuctions = auctionsByAccount[cred.username];
    if (userAuctions && userAuctions.length) {
      tasks.push(handleUserBids(cred, userAuctions));
    }
  }
  await Promise.all(tasks);
  return auctions;
});


/* ====================== stop-update / close-all-windows ====================== */
ipcMain.handle('stop-update', async () => {
  for (const t of bidTimeouts) {
    clearTimeout(t.timeoutId);
  }
  bidTimeouts.length = 0;
  return 'All scheduled bids canceled. Browsers remain open.';
});

ipcMain.handle('close-all-windows', async () => {
  for (const username of Object.keys(browserMap)) {
    const { browser } = browserMap[username];
    if (browser) {
      await browser.close();
    }
  }
  for (const k in browserMap) {
    delete browserMap[k];
  }
  return 'All browser windows closed.';
});

/* ====================== EXTRACT PROPERTIES => Download CSV ====================== */
ipcMain.handle('extract-properties', async (event, urlToExtract) => {
  console.log('[IPC] extract-properties =>', urlToExtract);
  let addedCount = 0;

  const browser = await puppeteer.launch({ headless: HEADLESS_EXTRACTION });
  const page = await browser.newPage();

  const downloadDir = path.join(__dirname, 'downloads');
  if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
  }
  const cdp = await page.target().createCDPSession();
  await cdp.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadDir,
  });

  try {
    await page.goto(urlToExtract, { waitUntil: 'networkidle2', timeout: 60000 });
    const linkSelector = 'a[title="Download a spreadsheet of these search results"]';
    await page.waitForSelector(linkSelector, { timeout: 20000 });
    await page.click(linkSelector);

    let csvPath = '';
    for (let i = 0; i < 20; i++) {
      const files = fs.readdirSync(downloadDir);
      const csvFile = files.find(f => f.toLowerCase().endsWith('.csv'));
      if (csvFile) {
        csvPath = path.join(downloadDir, csvFile);
        break;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!csvPath) {
      await browser.close();
      return { count: 0, message: 'No CSV file found or site changed.' };
    }

    const csvText = fs.readFileSync(csvPath, 'utf8');
    let records = [];
    try {
      const { parse } = require('csv-parse/sync');
      records = parse(csvText, {
        columns: true,
        skip_empty_lines: true,
        relax_quotes: true,
        relax_column_count: true,
      });
    } catch (parseErr) {
      console.error('[Extract] parse error =>', parseErr);
      throw parseErr;
    }

    for (const row of records) {
      for (const [key, val] of Object.entries(row)) {
        if (typeof val === 'string' && val.startsWith('=')) {
          row[key] = val.slice(1);
        }
      }
    }

    const { credentials, auctions } = loadData();
    let maxId = auctions.reduce((acc, a) => Math.max(acc, a.id || 0), 0);

    for (const row of records) {
      const startDate = row["AUCTION START DATE"] || '';
      const address = row["PROPERTY ADDRESS"] || '';
      const link = row["URL"] || '';
      if (!startDate || !link) continue;

      maxId++;
      const timeToBid = convertAuctionDate(startDate);
      const shortId = convertCivicSourceUrlToIdAuction(link);
      if (auctions.some(a => a.idAuction === shortId)) {
        console.log(`[Extract] skipping duplicate => ${shortId}`);
        continue;
      }

      const newAuction = {
        id: maxId,
        timeToBid,
        idAuction: shortId,
        bidProxy: '0',
        address,
        account: '',
        bidPlaced: ''
      };
      auctions.push(newAuction);
      addedCount++;
    }

    saveData({ credentials, auctions });
  } catch (err) {
    console.error('[Extract] Error =>', err);
  } finally {
    await browser.close();
  }

  return { count: addedCount, message: 'CSV extraction completed.' };
});

/* ====================== import-properties / save-properties-locally ====================== */
ipcMain.handle('import-properties', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Select JSON file to import',
    filters: [{ name: 'JSON Files', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) {
    return 'Import canceled.';
  }
  const importPath = filePaths[0];
  const raw = fs.readFileSync(importPath, 'utf8');
  const parsed = JSON.parse(raw);

  const filePath = getCredentialsFilePath();
  fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), 'utf8');
  return `Imported successfully from ${importPath}`;
});

ipcMain.handle('save-properties-locally', async () => {
  const res = await dialog.showSaveDialog({
    title: 'Save credentials.json as...',
    filters: [{ name: 'JSON Files', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePath) {
    return 'Save canceled.';
  }
  const { credentials, auctions } = loadData();
  fs.writeFileSync(res.filePath, JSON.stringify({ credentials, auctions }, null, 2), 'utf8');
  return `Saved successfully to ${res.filePath}`;
});