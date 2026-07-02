import { BrowserWindow, dialog } from 'electron';
import { writeFile } from 'fs/promises';
import { getMainWindow } from '../../windows/mainWindow';
import { resumePrintDocument } from './resumeHtml';

/**
 * Render the tailored resume (markdown) to an ATS-friendly PDF and let the user
 * pick where to save it. Renders in a hidden, ephemeral BrowserWindow loading a
 * self-contained data: URL (inline style only — CSP-compliant, no scripts), then
 * webContents.printToPDF. Returns { saved:false } when the user cancels the dialog.
 */
export async function exportResumePdf(
  markdown: string,
  suggestedName: string,
): Promise<{ saved: boolean; filePath?: string }> {
  // Windows-invalid filename chars → '-', keep it readable.
  const safeName = `${suggestedName.replace(/[\\/:*?"<>|]/g, '-').trim() || 'Tailored resume'}.pdf`;

  const win = getMainWindow();
  const options = { defaultPath: safeName, filters: [{ name: 'PDF', extensions: ['pdf'] }] };
  const res = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
  if (res.canceled || !res.filePath) return { saved: false };

  const printWin = new BrowserWindow({
    show: false, // printToPDF renders offscreen — the window is never displayed
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    const html = resumePrintDocument(markdown);
    // loadURL resolves on did-finish-load, so the DOM is painted before printing.
    await printWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const pdf = await printWin.webContents.printToPDF({
      pageSize: 'Letter',
      landscape: false,
      printBackground: false,
      displayHeaderFooter: false,
      // Electron 33: inches. Modest margins keep ATS text extraction clean.
      margins: { marginType: 'custom', top: 0.5, bottom: 0.5, left: 0.6, right: 0.6 },
      generateTaggedPDF: true, // tagged/structured PDF = most reliable ATS extraction
    });
    await writeFile(res.filePath, pdf);
    return { saved: true, filePath: res.filePath };
  } finally {
    printWin.destroy(); // never leak the hidden window, even on failure
  }
}
