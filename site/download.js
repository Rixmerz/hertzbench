// Download section: detects the visitor's system and links the latest GitHub
// Release asset for each platform. Without JavaScript, or when the API cannot
// answer, the rows keep their static link to the releases page.
//
// Asset names are matched loosely (OS and arch tokens), because the project
// publishes no release yet and has not fixed a naming scheme.
(() => {
  "use strict";

  const REPO = "Rixmerz/hertzbench";
  const RELEASES_URL = `https://github.com/${REPO}/releases`;
  const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
  // Only links that stay on GitHub's release hosting are written into an href.
  const ASSET_URL = /^https:\/\/github\.com\/Rixmerz\/hertzbench\/releases\/download\//;
  const NOT_A_BUILD = /\.(sha\d+|sig|asc|pem|sbom|json|jsonl|txt|md|minisig|sha256sum)$|checksums?|sha\d+sums?/i;

  /** "linux", "macos" or "windows", or null when the name says none of them. */
  function osOf(name) {
    if (/windows|win32|win64|msvc|\.exe$|\.msi$/i.test(name)) return "windows";
    if (/darwin|apple|macos|\bmac\b|osx|\.dmg$|\.pkg$/i.test(name)) return "macos";
    if (/linux|\.deb$|\.rpm$|appimage/i.test(name)) return "linux";
    return null;
  }

  /** "x64" or "arm64", or null when the name says neither. */
  function archOf(name) {
    if (/aarch64|arm64/i.test(name)) return "arm64";
    if (/x86[_-]64|x64|amd64|win64/i.test(name)) return "x64";
    return null;
  }

  /** What system an asset is for, or null for checksums, signatures and unknowns. */
  function classify(name) {
    if (NOT_A_BUILD.test(name)) return null;
    const os = osOf(name);
    return os ? { os, arch: archOf(name) } : null;
  }

  /**
   * The visitor's system from the user agent and, when the browser gives them,
   * the high-entropy client hints. An arch the browser does not reveal stays
   * null: Safari and Firefox report an Intel Mac on Apple silicon.
   */
  function detect(ua, hints) {
    const hint = hints || {};
    let os = null;
    if (hint.platform === "Windows") os = "windows";
    else if (hint.platform === "macOS") os = "macos";
    else if (hint.platform === "Linux") os = "linux";
    else if (!hint.platform) {
      if (/Android|iPhone|iPad|iPod|CrOS/.test(ua)) os = null;
      else if (/Windows/.test(ua)) os = "windows";
      else if (/Macintosh|Mac OS X/.test(ua)) os = "macos";
      else if (/Linux|X11/.test(ua)) os = "linux";
    }
    let arch = null;
    if (hint.architecture === "arm") arch = "arm64";
    else if (hint.architecture === "x86" && hint.bitness === "64") arch = "x64";
    else if (!hint.architecture) {
      if (/aarch64|arm64/i.test(ua)) arch = "arm64";
      else if (os !== "macos" && /x86_64|x64|Win64|amd64/i.test(ua)) arch = "x64";
    }
    return { os, arch };
  }

  async function hints() {
    const data = navigator.userAgentData;
    if (!data || !data.getHighEntropyValues) return null;
    try {
      const values = await data.getHighEntropyValues(["architecture", "bitness", "platform"]);
      return { platform: values.platform, architecture: values.architecture, bitness: values.bitness };
    } catch (_) {
      // Hints refused by the browser: the user agent string is all there is.
      return null;
    }
  }

  function megabytes(bytes) {
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }

  function setStatus(element, state, text, link) {
    element.dataset.state = state;
    element.textContent = text;
    if (link) {
      element.append(" ");
      const a = document.createElement("a");
      a.href = link.href;
      a.textContent = link.text;
      element.append(a);
    }
  }

  function setRow(row, state, asset) {
    const action = row.querySelector(".build-action");
    action.textContent = "";
    if (asset) {
      const a = document.createElement("a");
      a.href = asset.url;
      a.textContent = asset.name;
      action.append(a);
      if (asset.size > 0) {
        const size = document.createElement("span");
        size.className = "size";
        size.textContent = megabytes(asset.size);
        action.append(size);
      }
      return;
    }
    const span = document.createElement("span");
    span.className = "none";
    span.textContent = state;
    action.append(span);
  }

  function markDetected(list, system) {
    list.dataset.os = system.os || "";
    list.dataset.arch = system.arch || "";
    if (!system.os) return;
    for (const row of list.querySelectorAll("li")) {
      const [os, arch] = row.dataset.key.split("-");
      if (os !== system.os || (system.arch && arch !== system.arch)) continue;
      row.dataset.detected = "true";
      const badge = document.createElement("span");
      badge.className = "here";
      badge.textContent = "Your system";
      row.querySelector(".build-name").append(badge);
    }
    for (const details of document.querySelectorAll("details.os")) {
      const mine = details.id === `os-${system.os}`;
      details.open = mine;
      if (mine) details.dataset.detected = "true";
    }
  }

  async function main() {
    const list = document.getElementById("downloads");
    const status = document.getElementById("release-status");
    if (!list || !status) return;

    const system = detect(navigator.userAgent, await hints());
    markDetected(list, system);
    setStatus(status, "loading", "Checking the latest release…");

    let response;
    try {
      response = await fetch(API_URL, { headers: { Accept: "application/vnd.github+json" } });
    } catch (_) {
      setStatus(status, "error", "Could not reach the GitHub API.", {
        href: RELEASES_URL,
        text: "Open the releases page.",
      });
      return;
    }
    if (response.status === 404) {
      for (const row of list.querySelectorAll("li")) setRow(row, "No build published", null);
      setStatus(status, "none", "No release is published yet. Hertzbench runs from source with Deno: see Install below.");
      return;
    }
    if (!response.ok) {
      setStatus(status, "error", `GitHub answered with status ${response.status}.`, {
        href: RELEASES_URL,
        text: "Open the releases page.",
      });
      return;
    }

    let release;
    try {
      release = await response.json();
    } catch (_) {
      setStatus(status, "error", "GitHub sent an answer this page cannot read.", {
        href: RELEASES_URL,
        text: "Open the releases page.",
      });
      return;
    }

    const assets = Array.isArray(release.assets) ? release.assets : [];
    let linked = 0;
    for (const row of list.querySelectorAll("li")) {
      const [os, arch] = row.dataset.key.split("-");
      const found = assets.find((asset) => {
        if (typeof asset.name !== "string" || !ASSET_URL.test(String(asset.browser_download_url))) {
          return false;
        }
        const kind = classify(asset.name);
        return kind && kind.os === os && (kind.arch === null || kind.arch === arch);
      });
      if (found) linked++;
      setRow(row, "Not in this release", found && {
        name: found.name,
        url: found.browser_download_url,
        size: typeof found.size === "number" ? found.size : 0,
      });
    }

    const tag = typeof release.tag_name === "string" ? release.tag_name : "unnamed";
    const when = Date.parse(release.published_at);
    const date = Number.isNaN(when) ? "" : `, published ${new Date(when).toISOString().slice(0, 10)}`;
    if (linked === 0) {
      setStatus(status, "empty", `Latest release ${tag}${date}, has no build for Windows, macOS or Linux.`, {
        href: typeof release.html_url === "string" && release.html_url.startsWith("https://github.com/")
          ? release.html_url
          : RELEASES_URL,
        text: "See what it contains.",
      });
    } else {
      setStatus(status, "ok", `Latest release ${tag}${date}.`);
    }
  }

  globalThis.hertzbenchSite = { classify, detect };
  main();
})();
