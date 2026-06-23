# Shopify CSS Cleanup Tool

A full-stack Shopify theme cleanup app that scans your uploaded theme, finds unused CSS selectors, commented code, and unlinked CSS/JS files, then lets you remove only what you approve.

CSS removal is not supported for Tailwind CSS projects. Do not use the CSS Removal option on projects that use Tailwind CSS, as the tool may incorrectly identify and remove classes generated or used dynamically by Tailwind.

## What it does

- Upload a Shopify theme folder, files, or a ZIP archive
- Scan `.css`, `.liquid`, `.html`, and `.js` files
- Analyze CSS inside `<style>` blocks in `.liquid` and `.html` files
- Mark selectors as used or unused
- Protect Liquid-driven dynamic class usage from accidental deletion
- Detect commented code that can be removed safely
- Detect stylesheet and script files that do not appear to be referenced anywhere
- Let you manually choose what to delete
- Create a backup before changing any files
- Update the uploaded workspace in place
- Download the updated workspace, backup ZIP, or PDF report

## How it works

1. Upload your theme or files.
2. The backend creates a job folder for that upload.
3. The scanner analyzes theme markup and stylesheets.
4. The UI shows separate review areas for:
   - unused CSS selectors
   - commented code
   - unlinked CSS files
   - unlinked JS files
   - performance recommendations
5. You select what should be removed.
6. The app creates a backup of the original files.
7. Selected items are removed from the workspace.
8. You download the cleaned output or restore the original state if needed.

## Project structure

- `frontend/` - React UI
- `backend/` - Node.js + Express API
- `backend/uploads/` - uploaded themes and cleaned output
- `backend/backups/` - original files saved before cleanup

## Supported uploads

You can upload:

- A single file
- Multiple files
- A folder / theme export
- A ZIP archive

## What gets removed

The tool can remove:

- unused CSS selectors
- commented code blocks
- CSS files that are not referenced
- JS files that are not referenced

It does not automatically remove dynamic Shopify Liquid-driven class usage. Those are treated as protected.

## Download options

- If the cleaned workspace contains one file, it downloads as that file directly.
- If the cleaned workspace contains multiple files, it downloads as a ZIP.
- You can also download a PDF report of removed CSS selectors or removed comments.
- The original workspace can be restored from the backup created during cleanup.

## Installation

1. Install dependencies from the project root:

```bash
npm install
```

2. Start the app:

```bash
npm run dev
```

3. Open the Vite URL shown in the terminal.

## If you see a port error

If you get `EADDRINUSE` for port `3001`, another backend process is already running. Stop the existing process and run `npm run dev` again.

If you want to start the backend and frontend separately, use:

```bash
npm run dev:backend
npm run dev:frontend
```

## Typical workflow

1. Upload a theme folder or ZIP.
2. Run the scan.
3. Review unused selectors and files.
4. Uncheck anything you want to keep.
5. Remove the selected items.
6. Download the optimized result or PDF report.

## Optional local folder export

In supported browsers, the app can write the cleaned files directly back into a local folder using the File System Access API. If the browser blocks that feature, you can still download the updated files normally.

## Notes

- This is a beginner-friendly starter project, so double check everuthing before use in actual projects. It currnelty gives 70%-80% accurate results.
