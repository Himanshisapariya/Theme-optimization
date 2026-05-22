# Shopify CSS Cleanup Tool

A basic full-stack app for safely scanning Shopify theme CSS, reporting unused selectors, and removing only the selectors you approve.

## What it does

- Upload a Shopify theme folder, individual CSS files, or a theme ZIP
- Scan `.css`, `.liquid`, `.html`, and `.js` files
- Scan CSS inside `<style>` blocks in `.liquid` and `.html` files when it is safe to do so
- Flag selectors as used or unused
- Keep dynamic Liquid-based class usage safe by treating it as protected
- Let you manually approve what to remove
- Create backups before any CSS is changed
- Update the uploaded workspace in place, then download a fresh copy, backup ZIP, or PDF removal report

## Project structure

- `frontend/` - React UI
- `backend/` - Node.js + Express API
- `backend/uploads/` - uploaded themes and the in-place updated workspace
- `backend/backups/` - original CSS backups before removal

## Upload types

You can upload:

- A single file
- Multiple files
- A folder / theme export
- A ZIP archive

## Download behavior

- If the updated result has only one file, the updated download is sent as that file directly.
- If the updated result has multiple files, the updated download is sent as a ZIP.
- After removal, you can also download a PDF report that lists which selectors were removed from which file.

## Setup

1. Install backend dependencies:

```bash
cd backend
npm install
```

2. Install frontend dependencies:

```bash
cd ../frontend
npm install
```

3. Start the backend:

```bash
cd ../backend
npm run dev
```

4. Start the frontend in another terminal:

```bash
cd ../frontend
npm run dev
```

5. Open the Vite URL shown in the terminal.

## Safety flow

The app always follows this order:

1. Upload
2. Scan
3. Review report
4. Manually approve selectors
5. Create backup
6. Remove CSS in place
7. Download an updated copy or backups

## Notes

- This is a beginner-friendly starter project, so the scan is intentionally conservative.
- Dynamic Shopify Liquid class usage is treated as protected rather than removed automatically.
- For production use, add authentication, rate limiting, and streaming upload handling.
