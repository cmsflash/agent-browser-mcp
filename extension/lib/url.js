// Shared by tabs.js and groups.js. It lives in its own module because
// groups.js creates a group's first tab with a real URL, and tabs.js imports
// groups.js — putting this in either one would make the pair circular.

export function normalizeUrl(url) {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) return "https://" + url;
  return url;
}
