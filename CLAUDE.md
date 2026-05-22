# CSS Optimizer Tool — Architecture Overview

## Architecture

Monorepo setup:

* `backend/` → Node.js + Express (runs on port `3001`)
* `frontend/` → React + Vite
* Frontend proxies all `/api/*` requests to the backend

---

# Data Flow

## 1. Upload — `POST /api/upload`

### Supported Upload Types

* Drag & drop folder
* File picker upload
* ZIP upload

### Process

* Backend generates:

```js
const jobId = crypto.randomUUID();
```

* Files stored at:

```txt
uploads/<jobId>/source/
```

* ZIP files extracted using `JSZip`

### Automatically Ignored

* `.DS_Store`
* `__MACOSX/`
* `.git/`

---

## 2. Scan — `POST /api/scan/:jobId`

Core logic lives in:

```txt
scanner.js → scanWorkspace()
```

### Scan Process

#### Source Parsing

Reads all:

* `.liquid`
* `.html`
* `.js`

Builds two corpora:

##### Static Corpus

Markup with Liquid syntax removed.

##### Dynamic Corpus

Contains only content inside:

* `{{ }}`
* `{% %}`

#### CSS Parsing

Parses:

* `.css` files
* `<style>` blocks inside `.liquid` and `.html`

Uses:

* `PostCSS`
* `postcss-selector-parser`

### Selector Detection Logic

For each selector:

* Extracts tokens:

  * class
  * id
  * tag
  * attribute
* Matches tokens against both corpora
* Uses word-boundary regex matching
* Prevents false matches such as:

```txt
.foo ≠ foobar
.foo ≠ -foo
```

### Liquid Protection

Any selector containing:

* `{{ }}`
* `{% %}`

is automatically marked as:

```txt
used
```

### Scan Result

Each selector receives:

```txt
used | unused
```

along with estimated byte size.

### Report Output

Saved at:

```txt
uploads/<jobId>/report.json
```

---

## 3. Review (Frontend UI)

Frontend displays two tables:

### Unused Selectors

* Preselected by default

### Used Selectors

* Displayed for reference

### User Action

Users can:

* uncheck selectors they want to keep

---

## 4. Remove — `POST /api/remove/:jobId`

### Validation

Backend validates:

* selected IDs exist
* selectors are actually marked unused

### Backup System

Original CSS files copied to:

```txt
backups/<jobId>/original/
```

### CSS Cleanup

Uses `PostCSS` to:

* remove selected selectors
* remove entire rule if all selectors are removed

### Inline Style Block Support

Also updates:

* `<style>` blocks inside `.liquid`
* `<style>` blocks inside `.html`

### Clean Workspace Output

Generated at:

```txt
uploads/<jobId>/cleaned/
```

### Manifest File

Saves:

* selected selector IDs
* timestamp

Stored as:

```txt
manifest.json
```

---

## 5. Download Options

| Endpoint                         | Output                               |
| -------------------------------- | ------------------------------------ |
| `/api/download/:jobId/optimized` | Cleaned files as single file or ZIP  |
| `/api/download/:jobId/backup`    | ZIP of original CSS before removal   |
| `/api/download/:jobId/report`    | PDF report listing removed selectors |

### PDF Generation

* Generated manually as raw PDF 1.4 byte stream
* No external PDF library dependency

---

## 6. Local Folder Write (Bonus Feature)

### Browser API

Uses:

```js
showDirectoryPicker()
```

(File System Access API)

### Process

After cleanup:

* Backend returns all files as base64 JSON
* Endpoint:

```txt
/api/export/:jobId/local
```

### Frontend Write Process

Frontend writes directly to disk using:

```txt
FileSystemWritableFileStream
```

### Benefit

* No ZIP download required
* Direct local workspace update

---

# Key Design Points

## No Database

* Entire system is file-system based
* Everything keyed by `jobId`

## Liquid Safety

Selectors containing Liquid syntax are never marked unused.

## Accurate Matching

Word-boundary matching prevents false positives.

## Full Style Coverage

Supports both:

* standalone `.css` files
* inline `<style>` blocks

## Lightweight PDF System

* No heavy PDF de
