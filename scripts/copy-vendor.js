// Copies Bootstrap's and Font Awesome's compiled assets from node_modules
// into public/vendor so the app can serve them itself — no CDN required at
// runtime. Runs automatically after `npm install` (see package.json
// "postinstall").
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function copyFile(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return true;
}

function copyDir(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return 0;
  fs.mkdirSync(destDir, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(srcDir)) {
    if (copyFile(path.join(srcDir, entry), path.join(destDir, entry))) count++;
  }
  return count;
}

let total = 0;

// ---------- Bootstrap ----------
const bsCss = path.join(root, 'node_modules', 'bootstrap', 'dist', 'css');
const bsJs = path.join(root, 'node_modules', 'bootstrap', 'dist', 'js');
const bsDestCss = path.join(root, 'public', 'vendor', 'bootstrap', 'css');
const bsDestJs = path.join(root, 'public', 'vendor', 'bootstrap', 'js');
[
  [path.join(bsCss, 'bootstrap.min.css'), path.join(bsDestCss, 'bootstrap.min.css')],
  [path.join(bsCss, 'bootstrap.min.css.map'), path.join(bsDestCss, 'bootstrap.min.css.map')],
  [path.join(bsJs, 'bootstrap.bundle.min.js'), path.join(bsDestJs, 'bootstrap.bundle.min.js')],
  [path.join(bsJs, 'bootstrap.bundle.min.js.map'), path.join(bsDestJs, 'bootstrap.bundle.min.js.map')],
].forEach(([src, dest]) => { if (copyFile(src, dest)) total++; });

// ---------- Font Awesome (Free) ----------
const faRoot = path.join(root, 'node_modules', '@fortawesome', 'fontawesome-free');
const faCss = path.join(faRoot, 'css');
const faFonts = path.join(faRoot, 'webfonts');
const faDestCss = path.join(root, 'public', 'vendor', 'fontawesome', 'css');
const faDestFonts = path.join(root, 'public', 'vendor', 'fontawesome', 'webfonts');
[
  [path.join(faCss, 'all.min.css'), path.join(faDestCss, 'all.min.css')],
].forEach(([src, dest]) => { if (copyFile(src, dest)) total++; });
total += copyDir(faFonts, faDestFonts);

if (total === 0) {
  console.warn('No vendor assets found in node_modules — skipping vendor copy.');
} else {
  console.log(`Copied ${total} vendor asset(s) into public/vendor/ (Bootstrap + Font Awesome).`);
}
