

// renderer.js
const { ipcRenderer } = require('electron');

/* ===================== HELPER: Asynchronous Dialogs =====================
   We'll define a couple of utility functions that call "dialog.showMessageBox"
   in main.js. The result is always an object with a 'response' number:
     0 => first button, 1 => second, etc.
*/
async function showDialog({ type = 'info', title = 'Message', message = '', buttons = ['OK'] }) {
  // This calls main.js: ipcMain.handle('show-dialog', ...)
  const result = await ipcRenderer.invoke('show-dialog', { type, title, message, buttons });
  return result; // The main process returns an object { response, checkboxChecked }
}

/** Show an OK-only message box. */
async function showMessageBox(msg, title = 'Notice') {
  const { response } = await showDialog({
    type: 'info',
    title,
    message: msg,
    buttons: ['OK']
  });
  // response == 0 => user clicked OK
}

/** Show a yes/no confirm box. Return boolean. */
async function showConfirmBox(msg, title = 'Confirm') {
  const { response } = await showDialog({
    type: 'question',
    title,
    message: msg,
    buttons: ['Yes', 'No'],
  });
  return (response === 0); // 0 => 'Yes', 1 => 'No'
}

/* ===================== EST CLOCK ===================== */
const estClockEl = document.getElementById('estClock');

function updateESTClock() {
  const now = new Date();
  const estOptions = { timeZone: 'America/New_York', hour12: false };
  const estString = now.toLocaleString('en-US', estOptions);
  const estDate = new Date(estString);

  const hours = String(estDate.getHours()).padStart(2, '0');
  const minutes = String(estDate.getMinutes()).padStart(2, '0');
  const seconds = String(estDate.getSeconds()).padStart(2, '0');

  estClockEl.textContent = `${hours}:${minutes}:${seconds}`;
}
updateESTClock();
setInterval(updateESTClock, 1000);

/* ===================== CREDENTIALS SECTION ===================== */
const credentialTableBody = document.querySelector('#credentialTable tbody');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const addCredentialBtn = document.getElementById('addCredentialBtn');

let credentialsList = [];

/** Load credentials from main, re-render, and update the account <select> */
async function loadAndRenderCredentials() {
  credentialsList = await ipcRenderer.invoke('get-credentials');
  renderCredentialsTable();
  populateAccountSelect();
}

function renderCredentialsTable() {
  credentialTableBody.innerHTML = '';

  credentialsList.forEach((cred, index) => {
    const tr = document.createElement('tr');

    // Username (contentEditable)
    const userTd = document.createElement('td');
    userTd.contentEditable = true;
    userTd.textContent = cred.username;
    userTd.addEventListener('blur', async () => {
      credentialsList[index].username = userTd.textContent.trim();
      await saveCredentials();
      populateAccountSelect(); // if changed, re-populate
    });
    tr.appendChild(userTd);

    // Password (contentEditable)
    const passTd = document.createElement('td');
    passTd.contentEditable = true;
    passTd.textContent = cred.password;
    passTd.addEventListener('blur', async () => {
      credentialsList[index].password = passTd.textContent.trim();
      await saveCredentials();
    });
    tr.appendChild(passTd);

    // Delete button
    const actionsTd = document.createElement('td');
    actionsTd.classList.add('actions');
    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', async () => {
      await removeCredential(cred.id);
    });
    actionsTd.appendChild(deleteBtn);
    tr.appendChild(actionsTd);

    credentialTableBody.appendChild(tr);
  });
}

async function removeCredential(id) {
  // no confirm() => we can do a confirm dialog:
  const ok = await showConfirmBox('Are you sure you want to remove this credential?', 'Remove?');
  if (!ok) return;

  credentialsList = credentialsList.filter((c) => c.id !== id);
  const success = await ipcRenderer.invoke('save-credentials', credentialsList);
  if (!success) {
    await showMessageBox('Error removing credential.', 'Error');
  } else {
    await loadAndRenderCredentials();
  }
}

async function saveCredentials() {
  const success = await ipcRenderer.invoke('save-credentials', credentialsList);
  if (!success) {
    await showMessageBox('Error saving credentials.', 'Error');
  }
}

addCredentialBtn.addEventListener('click', async () => {
  const userVal = usernameInput.value.trim();
  const passVal = passwordInput.value.trim();
  if (!userVal || !passVal) {
    await showMessageBox('Please fill in both username and password.', 'Notice');
    return;
  }

  const maxId = credentialsList.reduce((acc, c) => Math.max(acc, c.id || 0), 0);
  const newId = maxId + 1;

  const newCred = { id: newId, username: userVal, password: passVal };
  credentialsList.push(newCred);

  const success = await ipcRenderer.invoke('save-credentials', credentialsList);
  if (!success) {
    await showMessageBox('Error saving credentials.', 'Error');
    return;
  }

  usernameInput.value = '';
  passwordInput.value = '';
  await loadAndRenderCredentials();
});

/** Fill <select> #auctionAccountSelect with the current credentials. */
function populateAccountSelect() {
  const accountSelect = document.getElementById('auctionAccountSelect');
  if (!accountSelect) return;

  accountSelect.innerHTML = '';
  const placeholderOpt = document.createElement('option');
  placeholderOpt.value = '';
  placeholderOpt.textContent = '(Select Account)';
  accountSelect.appendChild(placeholderOpt);

  credentialsList.forEach((cred) => {
    const opt = document.createElement('option');
    opt.value = cred.username;
    opt.textContent = cred.username;
    accountSelect.appendChild(opt);
  });
}

/* ===================== AUCTIONS SECTION ===================== */
const auctionTableBody = document.getElementById('auctionTable').querySelector('tbody');

const auctionDateInput = document.getElementById('auctionDate');
const auctionTimeInput = document.getElementById('auctionTimeField');
const auctionIdInput = document.getElementById('auctionIdInput');
const bidProxyInput = document.getElementById('bidProxyInput');
const auctionAddressInput = document.getElementById('auctionAddressInput');
const auctionAccountSelect = document.getElementById('auctionAccountSelect');
const addAuctionBtn = document.getElementById('addAuctionBtn');

const startUpdateBtn = document.getElementById('startUpdateBtn');
const stopUpdateBtn = document.getElementById('stopUpdateBtn');
const closeAllWindowsBtn = document.getElementById('closeAllWindowsBtn');

const importPropertiesBtn = document.getElementById('importPropertiesBtn');
const savePropertiesBtn = document.getElementById('savePropertiesBtn');

const extractPropertiesUrlInput = document.getElementById('extractPropertiesUrl');
const extractPropertiesBtn = document.getElementById('extractPropertiesBtn');

let auctionsList = [];

function combineDateTime(dateVal, timeVal) {
  const [year, month, day] = dateVal.split('-');
  const [hour, minute] = timeVal.split(':');
  return `${month}/${day}/${year} ${hour}:${minute}`;
}

async function loadAndRenderAuctions() {
  auctionsList = await ipcRenderer.invoke('get-auctions');
  renderAuctionsTable();
}

function renderAuctionsTable() {
  auctionTableBody.innerHTML = '';

  auctionsList.forEach((auction, index) => {
    const tr = document.createElement('tr');

    // ID
    const idTd = document.createElement('td');
    idTd.textContent = auction.id || '';
    tr.appendChild(idTd);

    // timeToBid
    const timeTd = document.createElement('td');
    timeTd.contentEditable = true;
    timeTd.textContent = auction.timeToBid || '';
    timeTd.addEventListener('blur', async () => {
      auctionsList[index].timeToBid = timeTd.textContent.trim();
      await saveAuctions();
    });
    tr.appendChild(timeTd);

    // idAuction
    const idAuctionTd = document.createElement('td');
    idAuctionTd.contentEditable = true;
    idAuctionTd.textContent = auction.idAuction || '';
    idAuctionTd.addEventListener('blur', async () => {
      auctionsList[index].idAuction = idAuctionTd.textContent.trim();
      await saveAuctions();
    });
    tr.appendChild(idAuctionTd);

// bidProxy
const bidProxyTd = document.createElement('td');
bidProxyTd.contentEditable = true;

// Instead of just `auction.bidProxy || '10'`, parse and append '%':
const numericVal = parseFloat(auction.bidProxy) || 0;
// Display it with a '%' suffix:
bidProxyTd.textContent = numericVal + '%';

// On blur, parse the user input back to a number and re-format it
bidProxyTd.addEventListener('blur', async () => {
  // 1) Remove any existing '%' sign
  const rawText = bidProxyTd.textContent.replace('%', '').trim();
  // 2) Convert to a float
  let num = parseFloat(rawText);
  if (isNaN(num)) {
    num = 0; // default if user typed non-numeric
  }

  // 3) Save raw numeric in auctionsList
  auctionsList[index].bidProxy = num.toString(); // e.g. "4", "1", "0"

  // 4) Re-display with '%' appended
  bidProxyTd.textContent = num + '%';

  // 5) Finally, call saveAuctions() so it persists
  await saveAuctions();
});

tr.appendChild(bidProxyTd);


    // address
    const addressTd = document.createElement('td');
    addressTd.contentEditable = true;
    addressTd.textContent = auction.address || '';
    addressTd.addEventListener('blur', async () => {
      auctionsList[index].address = addressTd.textContent.trim();
      await saveAuctions();
    });
    tr.appendChild(addressTd);

    // account => <select>
    const accountTd = document.createElement('td');
    const select = document.createElement('select');

    const placeholderOpt = document.createElement('option');
    placeholderOpt.value = '';
    placeholderOpt.textContent = '(Select Account)';
    select.appendChild(placeholderOpt);

    credentialsList.forEach((cred) => {
      const opt = document.createElement('option');
      opt.value = cred.username;
      opt.textContent = cred.username;
      select.appendChild(opt);
    });

    select.value = auction.account || '';
    select.addEventListener('change', async () => {
      auctionsList[index].account = select.value;
      await saveAuctions();
    });

    accountTd.appendChild(select);
    tr.appendChild(accountTd);

    // bidPlaced (read-only)
    const bidPlacedTd = document.createElement('td');
    bidPlacedTd.textContent = auction.bidPlaced || '';
    tr.appendChild(bidPlacedTd);

    // Delete action
    const actionsTd = document.createElement('td');
    actionsTd.classList.add('actions');
    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', async () => {
      await removeAuction(index);
    });
    actionsTd.appendChild(deleteBtn);

    tr.appendChild(actionsTd);
    auctionTableBody.appendChild(tr);
  });
}

async function removeAuction(index) {
  // Confirm with Electron's asynchronous dialog
  const ok = await showConfirmBox('Remove this auction?', 'Confirm Delete');
  if (!ok) return;

  auctionsList.splice(index, 1);
  const success = await ipcRenderer.invoke('save-auctions', auctionsList);
  if (!success) {
    await showMessageBox('Error removing auction.', 'Error');
  } else {
    await loadAndRenderAuctions();
  }
}

async function saveAuctions() {
  const success = await ipcRenderer.invoke('save-auctions', auctionsList);
  if (!success) {
    await showMessageBox('Error saving auctions.', 'Error');
  }
}

addAuctionBtn.addEventListener('click', async () => {
  const dateVal = auctionDateInput.value.trim();
  const timeVal = auctionTimeInput.value.trim();

  if (!dateVal || !timeVal) {
    await showMessageBox('Please fill in Date and Time.', 'Notice');
    return;
  }

  const idVal = auctionIdInput.value.trim() || 'stg/####';
  const bidProxyVal = bidProxyInput.value.trim() || '10';
  const addressVal = auctionAddressInput.value.trim() || 'Address';
  const accountVal = auctionAccountSelect.value.trim() || '';

  const combinedTime = combineDateTime(dateVal, timeVal);
  const maxId = auctionsList.reduce((acc, c) => Math.max(acc, c.id || 0), 0);
  const newId = maxId + 1;

  const newAuction = {
    id: newId,
    timeToBid: combinedTime,
    idAuction: idVal,
    bidProxy: bidProxyVal,
    address: addressVal,
    account: accountVal,
    bidPlaced: ""
  };

  auctionsList.push(newAuction);
  const success = await ipcRenderer.invoke('save-auctions', auctionsList);
  if (!success) {
    await showMessageBox('Error saving auction.', 'Error');
    return;
  }

  // Clear form
  auctionDateInput.value = '';
  auctionTimeInput.value = '';
  auctionIdInput.value = '';
  bidProxyInput.value = '';
  auctionAddressInput.value = '';
  auctionAccountSelect.value = '';

  await loadAndRenderAuctions();
});

/* ===================== Start/Stop Bidding ===================== */
startUpdateBtn.addEventListener('click', async () => {
  if (!auctionsList.length) {
    await showMessageBox('No auctions to schedule.', 'Notice');
    return;
  }
  try {
    const updatedAuctions = await ipcRenderer.invoke('fetch-auctions-data', auctionsList);
    auctionsList = updatedAuctions;
    renderAuctionsTable();
    await showMessageBox('All bids have been scheduled in the main process!', 'Success');
  } catch (err) {
    console.error('Error scheduling bids:', err);
    await showMessageBox(`Error scheduling bids: ${err}`, 'Error');
  }
});

stopUpdateBtn.addEventListener('click', async () => {
  try {
    const msg = await ipcRenderer.invoke('stop-update');
    await showMessageBox(msg, 'Stopped');
  } catch (err) {
    console.error('Error stopping updates:', err);
    await showMessageBox(`Error stopping updates: ${err}`, 'Error');
  }
});

/* ===================== Close All Windows ===================== */
closeAllWindowsBtn.addEventListener('click', async () => {
  try {
    const msg = await ipcRenderer.invoke('close-all-windows');
    await showMessageBox(msg, 'Windows Closed');
  } catch (err) {
    console.error('Error closing all windows:', err);
    await showMessageBox(`Error closing: ${err}`, 'Error');
  }
});

/* ===================== Extract Properties ===================== */
if (extractPropertiesBtn) {
  extractPropertiesBtn.addEventListener('click', async () => {
    const urlToExtract = extractPropertiesUrlInput.value.trim();
    if (!urlToExtract) {
      await showMessageBox('Please paste a URL first.', 'Notice');
      return;
    }
    try {
      const result = await ipcRenderer.invoke('extract-properties', urlToExtract);
      await showMessageBox(`Extracted ${result.count} properties.\n${result.message}`, 'Extract');
      await loadAndRenderAuctions();
    } catch (err) {
      console.error('Error extracting properties:', err);
      await showMessageBox(`Error extracting: ${err}`, 'Error');
    }
  });
}

/* ===================== Import / Save Properties ===================== */
if (importPropertiesBtn) {
  importPropertiesBtn.addEventListener('click', async () => {
    try {
      const msg = await ipcRenderer.invoke('import-properties');
      await showMessageBox(msg, 'Imported');
      // Reload after importing
      await loadAndRenderCredentials();
      await loadAndRenderAuctions();
    } catch (err) {
      console.error('Error importing properties:', err);
      await showMessageBox(`Error importing: ${err}`, 'Error');
    }
  });
}

if (savePropertiesBtn) {
  savePropertiesBtn.addEventListener('click', async () => {
    try {
      const msg = await ipcRenderer.invoke('save-properties-locally');
      await showMessageBox(msg, 'Saved');
    } catch (err) {
      console.error('Error saving properties locally:', err);
      await showMessageBox(`Error saving: ${err}`, 'Error');
    }
  });
}

const clearAuctionsBtn = document.getElementById('clearAuctionsBtn');
if (clearAuctionsBtn) {
  clearAuctionsBtn.addEventListener('click', async () => {
    if (!auctionsList.length) {
      await showMessageBox('No auctions to clear.', 'Notice');
      return;
    }
    const ok = await showConfirmBox('Are you sure you want to clear ALL auctions?', 'Clear All?');
    if (!ok) return;

    auctionsList = [];
    const success = await ipcRenderer.invoke('save-auctions', auctionsList);
    if (!success) {
      await showMessageBox('Error clearing auctions.', 'Error');
    } else {
      await showMessageBox('All auctions have been cleared.', 'Done');
      await loadAndRenderAuctions();
    }
  });
}

/* ===================== INIT ===================== */
async function init() {
  await loadAndRenderCredentials();
  await loadAndRenderAuctions();
}
init();