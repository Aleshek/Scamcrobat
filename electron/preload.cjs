// Bridge between the app window and the main process. The window has no access
// to Node.js, only to these few functions.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

function listen(channel, callback) {
  const listener = () => callback();
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("scamcrobat", {
  platform: process.platform,
  takePendingFiles: () => ipcRenderer.invoke("file:take-pending"),
  onFilesPending: (callback) => listen("app:files-pending", callback),
  openFilesDialog: (title) => ipcRenderer.invoke("file:open-dialog", { title }),
  openPath: (filePath) => ipcRenderer.invoke("file:open-path", filePath),
  saveFile: (filePath, data) => ipcRenderer.invoke("file:save", filePath, data),
  saveFileAs: (suggestedName, defaultDir, data) => ipcRenderer.invoke("file:save-as", suggestedName, defaultDir, data),
  onSaveAndClose: (callback) => listen("app:save-and-close", callback),
  pickFolder: (defaultPath) => ipcRenderer.invoke("export:pick-folder", defaultPath),
  writeFile: (folder, name, data) => ipcRenderer.invoke("export:write", folder, name, data),
  showInFolder: (filePath) => ipcRenderer.invoke("shell:show-in-folder", filePath),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  setLanguage: (lang) => ipcRenderer.send("app:set-language", lang),
  print: () => ipcRenderer.invoke("app:print"),
  checkForUpdate: () => ipcRenderer.invoke("app:check-update"),
});
