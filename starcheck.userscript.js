// ==UserScript==
// @name         GitHub Stargazers Analyzer
// @namespace    https://github.com/
// @version      1.0
// @description  Analyze common starred repositories among a repo's stargazers to identify potential bot clusters.
// @match        https://github.com/*/*
// @exclude      https://github.com/*/*/ *
// @grant        GM_xmlhttpRequest
// @connect      api.github.com
// @connect      github.com
// ==/UserScript==

(function () {
    'use strict';

    // Only proceed if on a repository main page:
    // The URL path should be like /owner/repo with no further slashes (or a trailing slash).
    if (document.location.pathname.split('/').filter(s => s).length !== 2) {
        return; // not on a main repo page
    }

    // Find the stargazers link element (the "⭐  XXX stars" link).
    const starLink = document.querySelector('a[href$="/stargazers"].Link');
    if (!starLink) return;  // If not found, do nothing.

    // Create a container for our button and results
    const container = document.createElement('div');
    // Insert container right after the starLink's parent div.
    const parentDiv = starLink.closest('div');
    parentDiv.parentNode.insertBefore(container, parentDiv.nextSibling);

    // Style the container for better spacing
    container.style.margin = '0.5em 0';

    // Controls: configurable max users (default 300)
    const controls = document.createElement('div');
    controls.style.marginBottom = '0.5em';
    const limitLabel = document.createElement('span');
    limitLabel.textContent = 'Max stargazers: ';
    const limitInput = document.createElement('input');
    limitInput.type = 'number';
    limitInput.min = '1';
    limitInput.max = '2000';
    limitInput.value = '300';
    limitInput.setAttribute('aria-label', 'Max stargazers');
    limitInput.style.width = '6em';
    limitInput.style.marginRight = '0.5em';
    controls.appendChild(limitLabel);
    controls.appendChild(limitInput);
    container.appendChild(controls);

    // Create the "Check Stargazers" button
    const btn = document.createElement('button');
    btn.textContent = '🔎 Check Stargazers';
    // Use GitHub's button style classes if available
    btn.className = 'btn btn-sm';  // GitHub typically has .btn style
    container.appendChild(btn);

    // Create a div for output
    const outputDiv = document.createElement('div');
    outputDiv.style.fontFamily = 'Arial, sans-serif';
    outputDiv.style.whiteSpace = 'pre-wrap';  // Preserve newlines if any
    container.appendChild(outputDiv);

    // Helper: update outputDiv with text/html content
    function logOutput(html) {
        outputDiv.innerHTML = html;
    }

    // Main logic triggered on button click
    btn.addEventListener('click', async function () {
        btn.disabled = true;
        btn.textContent = 'Analyzing...';

        const [, owner, repo] = starLink.getAttribute('href').match(/^\/([^/]+)\/([^/]+)\/stargazers$/) || [];
        if (!owner || !repo) {
            logOutput(`<p style="color:red;">Failed to parse repository owner/name.</p>`);
            return;
        }
        const targetRepoFullName = `${owner}/${repo}`;

        // Fetch stargazer usernames by parsing HTML pages until empty, capped by limit
        const limitUsers = Math.max(1, parseInt(limitInput.value, 10) || 300);
        let stargazers = [];
        try {
            stargazers = await fetchStargazerUsernamesFromHtml(owner, repo, limitUsers);
        } catch (err) {
            logOutput(`<p style="color:red;">Error fetching stargazers (HTML): ${err}</p>`);
            btn.textContent = 'Check Stargazers';
            btn.disabled = false;
            return;
        }

        const totalCount = stargazers.length;

        // Prepare to fetch each user's starred repos
        const freqMap = {};  // frequency map of repo full_name -> count
        let notFoundCount = 0; // count of users whose stars page returns 404
        let processedCount = 0;

        for (const username of stargazers) {
            try {
                const starredFullNames = await fetchUserStarredReposFromHtml(username);
                for (const fullName of starredFullNames) {
                    if (fullName === targetRepoFullName) continue; // skip the target repo
                    freqMap[fullName] = (freqMap[fullName] || 0) + 1;
                }
            } catch (err) {
                if (err && err.status === 404) {
                    notFoundCount++;
                } else {
                    console.error('Error fetching starred repos for user', username, err);
                }
                // Continue on errors for individual users
            }

            processedCount++;
            // Update progress and top 10 list
            const top10 = getTopN(freqMap, 10);
            logOutput(renderResults(processedCount, totalCount, top10, notFoundCount));
        }

        btn.textContent = 'Check Stargazers';
        btn.disabled = false;
    });

        // Simple global rate limiter: ensure >= 1 request per second
        const RATE_LIMIT_MS = 1000;
        let lastRequestEnd = 0;
        function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
        async function withRateLimit(taskFn) {
            const now = Date.now();
            const wait = Math.max(0, RATE_LIMIT_MS - (now - lastRequestEnd));
            if (wait > 0) {
                await sleep(wait);
            }
            try {
                return await taskFn();
            } finally {
                lastRequestEnd = Date.now();
            }
        }

    // Helper function to perform API requests using GM_xmlhttpRequest, returning a Promise
    function apiRequest(url) {
        return withRateLimit(() => new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                headers: { 'Accept': 'application/vnd.github+json' },
                onload: function (response) {
                    if (response.status >= 200 && response.status < 300) {
                        resolve(response);
                    } else {
                        reject(new Error(`HTTP ${response.status} - ${response.statusText}`));
                    }
                },
                onerror: function (err) {
                    reject(new Error(`Request failed: ${err}`));
                }
            });
        }));
    }

    // Fetch a user's starred repositories by parsing only the first Stars tab page (no pagination)
    async function fetchUserStarredReposFromHtml(username) {
        const repoSet = new Set();
        const url = `https://github.com/${username}?tab=stars`;
        const { status, text } = await httpRequestHtmlWithStatus(url);
        if (status === 404) {
            const e = new Error('Not Found');
            e.status = 404;
            throw e;
        }

        const parser = new DOMParser();
        const doc = parser.parseFromString(text, 'text/html');

        // Prefer the starred repos frame/container; fallback to whole doc
        const scope = doc.querySelector('turbo-frame#user-starred-repos') ||
                      doc.querySelector('#user-starred-repos') ||
                      doc;

        // Robust repository link extraction with multiple selectors
        const selectorCandidates = [
            'a[data-hovercard-type="repository"][href^="/"]',
            'h3 a[data-hovercard-type="repository"][href^="/"]',
            'h3 a[href^="/"]',
            'a.Link--primary[data-hovercard-type="repository"][href^="/"]'
        ];

        for (const sel of selectorCandidates) {
            const anchors = scope.querySelectorAll(sel);
            for (const a of anchors) {
                const href = a.getAttribute('href') || '';
                const fullName = parseRepoFullNameFromHref(href);
                if (fullName) repoSet.add(fullName);
            }
        }

        // As a last resort, scan all anchors on the page and regex-match owner/repo
        if (repoSet.size === 0) {
            const allAnchors = scope.querySelectorAll('a[href^="/"]');
            for (const a of allAnchors) {
                const href = a.getAttribute('href') || '';
                const fullName = parseRepoFullNameFromHref(href);
                if (fullName) repoSet.add(fullName);
            }
        }

        return Array.from(repoSet);
    }

    // Normalize and validate repo full name from href like "/owner/repo" (filters out non-repo paths)
    function parseRepoFullNameFromHref(href) {
        if (!href) return null;
        // Must be exactly two path segments: /owner/repo (optional trailing slash)
        const m = href.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?(?:[#?].*)?$/);
        if (!m) return null;
        const owner = m[1];
        const repo = m[2];
        // Exclude common non-repo or special paths
        const blocked = new Set(['organizations', 'settings', 'apps', 'site', 'topics', 'collections', 'sponsors']);
        if (blocked.has(owner)) return null;
        return `${owner}/${repo}`;
    }

    // Helper: GET HTML via GM_xmlhttpRequest and return responseText
    function httpRequestHtml(url) {
        return withRateLimit(() => new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                headers: { 'Accept': 'text/html' },
                onload: function (response) {
                    if (response.status >= 200 && response.status < 300) {
                        resolve(response.responseText);
                    } else {
                        reject(new Error(`HTTP ${response.status} - ${response.statusText}`));
                    }
                },
                onerror: function (err) {
                    reject(new Error(`Request failed: ${err}`));
                }
            });
        }));
    }

    // Helper: GET HTML with status via GM_xmlhttpRequest
    function httpRequestHtmlWithStatus(url) {
        return withRateLimit(() => new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                headers: { 'Accept': 'text/html' },
                onload: function (response) {
                    resolve({ status: response.status, text: response.responseText });
                },
                onerror: function (err) {
                    reject(new Error(`Request failed: ${err}`));
                }
            });
        }));
    }

    // Parse stargazers from HTML pages
    async function fetchStargazerUsernamesFromHtml(owner, repo, maxUsers = 300) {
        const usernames = [];

        for (let page = 1; ; page++) {
            const url = `https://github.com/${owner}/${repo}/stargazers?page=${page}`;
            const html = await httpRequestHtml(url);

            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');

            // Prefer the main repo content frame/container if available
            const scope = doc.querySelector('turbo-frame#repo-content-turbo-frame') ||
                          doc.querySelector('#repo-content-pjax-container') ||
                          doc;

            // Collect anchor tags that refer to user profiles
            const anchors = scope.querySelectorAll('a[data-hovercard-type="user"][href^="/"]');
            const before = usernames.length;
            for (const a of anchors) {
                const href = a.getAttribute('href') || '';
                const m = href.match(/^\/([A-Za-z0-9-]+)\/?$/);
                if (!m) continue;
                const login = m[1];
                if (!usernames.includes(login)) {
                    usernames.push(login);
                }
                if (usernames.length >= maxUsers) break;
            }
            // If this page yields no new usernames, we've reached the end
            if (usernames.length === before) break;
            if (usernames.length >= maxUsers) break;
        }

        return usernames;
    }

    // Helper function to get top N entries from frequency map
    function getTopN(freqMap, N) {
        const entries = Object.entries(freqMap);  // [ [repoFullName, count], ... ]
        // Sort by count descending
        entries.sort((a, b) => b[1] - a[1]);
        return entries.slice(0, N);
    }

    // Helper function to render the results HTML
    function renderResults(processed, total, topList, notFoundCount = 0) {
        let html = `<p><strong>Processed ${processed}/${total} stargazers</strong></p>`;
        if (notFoundCount > 0) {
            html += `<p>Hidden/404 profiles: <strong>${notFoundCount}</strong></p>`;
        }
        if (topList.length === 0) {
            html += `<p>(No starred repositories recorded yet.)</p>`;
            return html;
        }
        html += `<ol>`;
        for (const [repoFullName, count] of topList) {
            const percentage = ((count / processed) * 100).toFixed(1);
            html += `<li>${repoFullName} – <strong>${count}</strong> users (${percentage}% of processed)</li>`;
        }
        html += `</ol>`;
        return html;
    }

})();
