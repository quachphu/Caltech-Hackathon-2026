const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');

app.whenReady().then(() => {
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    return true;
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(true);
  });
  
  fs.writeFileSync('test.html', '<html><body><script>const SR = window.SpeechRecognition || window.webkitSpeechRecognition; if(SR){const sr = new SR(); sr.onstart=()=>console.log("STARTED"); sr.onerror=(e)=>console.log("ERR:",e.error); sr.onresult=(e)=>console.log("RES:",e); setTimeout(()=>sr.start(), 500);}else{console.log("NO_API")} setTimeout(() => require("electron").ipcRenderer.send("done"), 4000);</script></body></html>');
  
  const win = new BrowserWindow({
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  win.loadFile('test.html');
  ipcMain.on('done', () => app.quit());
});
