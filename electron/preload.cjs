// Most mezi oknem aplikace a hlavním procesem. Okno nemá přístup k Node.js,
// jen k těmto několika funkcím.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("scamcrobat", {
  platform: process.platform,
  getInitialFile: () => ipcRenderer.invoke("file:initial"),
  openFileDialog: () => ipcRenderer.invoke("file:open-dialog"),
  openFilesDialog: (title) => ipcRenderer.invoke("file:open-dialog", { multiple: true, title }),
  openPath: (filePath) => ipcRenderer.invoke("file:open-path", filePath),
  saveFile: (filePath, data) => ipcRenderer.invoke("file:save", filePath, data),
  saveFileAs: (suggestedName, defaultDir, data) => ipcRenderer.invoke("file:save-as", suggestedName, defaultDir, data),
  onSaveAndClose: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("app:save-and-close", listener);
    return () => ipcRenderer.removeListener("app:save-and-close", listener);
  },
  pickFolder: (defaultPath) => ipcRenderer.invoke("export:pick-folder", defaultPath),
  writeFile: (folder, name, data) => ipcRenderer.invoke("export:write", folder, name, data),
  showInFolder: (filePath) => ipcRenderer.invoke("shell:show-in-folder", filePath),
  getPathForFile: (file) => webUtils.getPathForFile(file),
});
