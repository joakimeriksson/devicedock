# Vendored libraries

The page loads these files as they are: there is no npm and no build step. Each is the prebuilt ES module file
published in the package's npm tarball, copied unchanged with its licence, except where noted. To update one,
download the new tarball, copy the same files, and update the version and hashes here.

| Package | Version | Files here (from the tarball) | Source |
| --- | --- | --- | --- |
| preact | 10.29.8 | `preact/preact.module.js` (`dist/preact.module.js`), `preact/hooks.module.js` (`hooks/dist/hooks.module.js`), `preact/LICENSE` | https://registry.npmjs.org/preact/-/preact-10.29.8.tgz |
| htm | 3.1.1 | `htm/htm.module.js` (`dist/htm.module.js`), `htm/LICENSE` | https://registry.npmjs.org/htm/-/htm-3.1.1.tgz |
| @xterm/xterm | 6.0.0 | `xterm/xterm.mjs` (`lib/xterm.mjs`), `xterm/xterm.css` (`css/xterm.css`), `xterm/LICENSE` | https://registry.npmjs.org/@xterm/xterm/-/xterm-6.0.0.tgz |
| @xterm/addon-fit | 0.11.0 | `xterm-addon-fit/addon-fit.mjs` (`lib/addon-fit.mjs`), `LICENSE` | https://registry.npmjs.org/@xterm/addon-fit/-/addon-fit-0.11.0.tgz |
| @xterm/addon-search | 0.16.0 | `xterm-addon-search/addon-search.mjs` (`lib/addon-search.mjs`), `LICENSE` | https://registry.npmjs.org/@xterm/addon-search/-/addon-search-0.16.0.tgz |
| @xterm/addon-unicode11 | 0.9.0 | `xterm-addon-unicode11/addon-unicode11.mjs` (`lib/addon-unicode11.mjs`), `LICENSE` | https://registry.npmjs.org/@xterm/addon-unicode11/-/addon-unicode11-0.9.0.tgz |
| @xterm/addon-web-links | 0.12.0 | `xterm-addon-web-links/addon-web-links.mjs` (`lib/addon-web-links.mjs`), `LICENSE` | https://registry.npmjs.org/@xterm/addon-web-links/-/addon-web-links-0.12.0.tgz |
| @xterm/addon-webgl | 0.19.0 | `xterm-addon-webgl/addon-webgl.mjs` (`lib/addon-webgl.mjs`), `LICENSE` | https://registry.npmjs.org/@xterm/addon-webgl/-/addon-webgl-0.19.0.tgz |

The xterm tarballs are the ones `package-lock.json` pinned before (same sha512 integrity). Licences: Preact and xterm.js
are MIT, htm is Apache-2.0 (each package's `LICENSE` is next to its files).

**One change:** `preact/hooks.module.js` imports `"preact"`, a bare name that only a bundler or an import map can
resolve. The page's CSP (`script-src 'self'`) does not allow an inline import map, so that one import is rewritten
to `"./preact.module.js"`; nothing else in the file differs.

## SHA-256

```text
c30e721ebfdc6e2ad4c18c14d2dfb82667829c8aec27de1207774e3fc16858a8  preact/preact.module.js
a6ee626f2d01570592dd569a792e3f050154aa02890eead8c223fa3ed5aa3d5a  preact/hooks.module.js (as published)
f3555e7a8dba84175c94f17148ba6670e4b3716888fe06b3330a485637296a38  preact/hooks.module.js (here, import rewritten)
ab33dd3f38059b9be4d5f5350128eefb2356639c4e0bbe9d9e8b3ba75847e9e4  htm/htm.module.js
b336ec65a086c056d4804b3d4c2347da5663d3f23c3f25be866467bd8857ad59  xterm/xterm.mjs
854a7c0fb70e8b1a083c16797ab827299fb18744f5ad34f227b48337e33293c6  xterm/xterm.css
2d87e1bddc73be9111de8beee5370c3bb7aac9c94e18e6f245f02ca741ef1769  xterm-addon-fit/addon-fit.mjs
3ea90162233f867b938cd29b8ad98f589643436bbb5445bd11b825dc99ff0c04  xterm-addon-search/addon-search.mjs
37bb2d573c615661c875398be2a3497e02bd21d7202a5d1159f6ab70a8cfc2f2  xterm-addon-unicode11/addon-unicode11.mjs
cce9cc1905c4d369dfa70ef0ed1eea12700754818a6c480d1fd94895dddd1a25  xterm-addon-web-links/addon-web-links.mjs
5ac2cbbb8a861ba99176eda0ee91f10c08de32d091e3488edf699ad111131ebb  xterm-addon-webgl/addon-webgl.mjs
```

Check with `cd apps/web/vendor && shasum -a 256 */*.js */*.mjs */*.css`.

The files still end in a `//# sourceMappingURL=` comment; the maps are not vendored, so the browser's developer tools
show the minified code.
