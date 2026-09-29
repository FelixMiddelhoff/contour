const { app, BrowserWindow } = require("electron");
const path = require("path");
const http = require("http");
const next = require("next");

let mainWindow;

async function createWindow() {
  const nextApp = next({ dev: false, dir: path.join(__dirname, "..") });
  const handle = nextApp.getRequestHandler();
  await nextApp.prepare();

  const server = http.createServer((req, res) => handle(req, res));

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: "contour",
    autoHideMenuBar: true,
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}`);

  app.on("before-quit", () => server.close());
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
