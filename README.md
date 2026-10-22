# TurnLeaf: Offline Ebook Reader 1.2 – build the Android APK

Read or listen to any book in small daily parts. This folder is a ready-to-build Android app.

## Easiest way: build the APK online (no Android Studio needed)
1. Create a free GitHub account and a new empty repository (for example `turnleaf`).
2. Upload everything in this folder to the repository (keep the `.github` folder).
3. Open the repository's **Actions** tab. The "Build Android APK" job starts by itself (or press **Run workflow**).
4. After about 5 to 8 minutes, open the finished run and download **turnleaf-apk** at the bottom. Unzip it to get `app-debug.apk`.
5. Copy the APK to your phone, open it, and allow "Install unknown apps" when Android asks.

## Build on your own computer instead
Needs Node 20+, Java 17 and Android Studio (for the Android SDK).
```
npm install
npm run prep
npx cap add android
npx cap sync android
cd android && ./gradlew assembleDebug
```
The APK appears in `android/app/build/outputs/apk/debug/app-debug.apk`.

## Compatibility
- Works on Android 5.1 and newer (API 22+), on phones and tablets, 32-bit and 64-bit.
- Needs "Android System WebView" (updated through Google Play). Very old, never-updated phones may show an old WebView; updating it fixes that.
- PDF and EPUB readers and a native text-to-speech voice are bundled, so importing books and listening work offline.

## Reading view
EPUB, text and reflowed books open in `bookReader.js` + `reader.css` (two-page spread on wide screens, single page on phones, page-turn animation, pinch zoom, font size and page colour). PDFs that have a stored copy still open in the PDF page view. EPUB files are now stored on import so images and styling show; EPUBs added before this version open as plain text and need to be added again for the full look.

## Without an APK
`www/index.html` also runs as an installable web app: host the `www` folder on any HTTPS site, open it in Chrome on your phone and choose **Add to Home screen**.

## Contents drawer and saved position
The list button in the reader's top bar opens a slide-over **Contents** drawer: tap a chapter to jump straight to it, the chapter you are in is highlighted, and the Android back button or a tap outside closes it. The reader saves your page and chapter index in `localStorage` after every page turn (key `turnleaf:<book id>`) and reopens the book on that page; if the text size or screen size has changed since, it returns to the same spot inside the chapter instead.

## Reading journal
The **Journal** tab (between Library and Plan) keeps quotes and thoughts from your books. Tap **+** to add an entry, tap an entry to edit or delete it. The **Note** button in each reader (the daily reader, the page-by-page reader and the EPUB/text reader) opens the same form with the book title, and the page number where there is one, already filled in. Entries are saved on the device in `localStorage` under `readingJournal.entries`. Code: `www/journal.js` and `www/journal.css`; colours follow the app's light and dark themes. Android's back button closes the note form first.

## Prototype files
`prototype/` holds the original standalone shell (`index.html`, `nav.js`, `nav.css`) the journal was built in. It is not shipped in the app: TurnLeaf's own tab bar and back-button handling replace it.
