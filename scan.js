#!/usr/bin/env node

const https = require('https');
const http = require('http');
const fs = require('fs');

const BASE_URL = 'https://darogan.wales';

function fetchHTML(urlString) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlString);
    const protocol = urlObj.protocol === 'https:' ? https : http;

    const req = protocol.request(urlObj, {
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DaroganLinkChecker/1.0)' }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.end();
  });
}

function extractLinks(html, baseURL) {
  const links = new Set();
  const hrefRegex = /href=["']([^"']+)["']/g;
  let match;

  while ((match = hrefRegex.exec(html)) !== null) {
    let href = match[1];
    if (
      href &&
      !href.startsWith('#') &&
      !href.startsWith('mailto:') &&
      !href.startsWith('tel:') &&
      !href.startsWith('javascript:')
    ) {
      try {
        let fullUrl = href;
        if (href.startsWith('/')) {
          fullUrl = baseURL + href;
        } else if (!href.startsWith('http')) {
          fullUrl = baseURL + '/' + href;
        }
        const parsed = new URL(fullUrl);
        links.add(parsed.href);
      } catch (e) {
        // skip invalid URLs
      }
    }
  }

  return Array.from(links);
}

function checkLink(href, attempts = 2, timeoutMs = 20000) {
  return new Promise(async (resolve) => {
    const result = {
      url: href,
      status: 'checking',
      statusCode: null,
      statusText: 'Checking...',
      isOldDomain: false,
      isInternal: false,
      error: null
    };

    if (href.includes('darogantalent')) {
      result.isOldDomain = true;
      result.status = 'warning';
      result.statusText = 'Uses deprecated domain (darogantalent)';
      return resolve(result);
    }

    result.isInternal = href.includes('darogan');

    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await new Promise((res, rej) => {
          const urlObj = new URL(href);
          const protocol = urlObj.protocol === 'https:' ? https : http;

          const req = protocol.request(
            urlObj,
            {
              method: 'HEAD',
              timeout: timeoutMs,
              headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DaroganLinkChecker/1.0)' }
            },
            (r) => {
              r.resume();
              res({ statusCode: r.statusCode, statusMessage: r.statusMessage });
            }
          );

          req.on('error', rej);
          req.on('timeout', () => {
            req.destroy();
            rej(new Error('Request timeout'));
          });
          req.end();
        });

        result.statusCode = response.statusCode;
        result.statusText = getStatusText(response.statusCode);

        if (response.statusCode === 404 || response.statusCode >= 400) {
          result.status = 'error';
        } else {
          result.status = 'ok';
        }
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
      }
    }

    if (lastError) {
      result.status = 'error';
      result.statusText = `Failed after ${attempts} attempts: ${lastError.message}`;
      result.error = lastError.message;
    }

    resolve(result);
  });
}

function getStatusText(status) {
  const statuses = {
    200: 'OK',
    301: 'Moved Permanently',
    302: 'Found',
    304: 'Not Modified',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable'
  };
  return statuses[status] || `Status ${status}`;
}

async function main() {
  console.log('Fetching homepage...');
  const html = await fetchHTML(BASE_URL);

  console.log('Extracting links...');
  const links = extractLinks(html, BASE_URL);
  console.log(`Found ${links.length} unique links`);

  const results = {
    totalLinks: links.length,
    validLinks: 0,
    brokenLinks: 0,
    oldDomainLinks: 0,
    links: [],
    startTime: new Date().toISOString(),
    endTime: null
  };

  // Check links with a small concurrency (5 at a time) - no subrequest limits here!
  const concurrency = 5;
  for (let i = 0; i < links.length; i += concurrency) {
    const batch = links.slice(i, i + concurrency);
    console.log(`Checking ${i + 1}-${Math.min(i + concurrency, links.length)} / ${links.length}...`);

    const batchResults = await Promise.all(batch.map((link) => checkLink(link)));

    batchResults.forEach((result) => {
      results.links.push(result);
      if (result.status === 'ok') results.validLinks++;
      if (result.status === 'error') results.brokenLinks++;
      if (result.isOldDomain) results.oldDomainLinks++;
    });
  }

  results.endTime = new Date().toISOString();

  fs.writeFileSync('results.json', JSON.stringify(results, null, 2));
  console.log('Saved results.json');
  console.log(`Valid: ${results.validLinks}, Broken: ${results.brokenLinks}, Old domain: ${results.oldDomainLinks}`);
}

main().catch((err) => {
  console.error('Scan failed:', err);
  process.exit(1);
});
