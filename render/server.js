const express = require('express');
const app = express();

const TARGET_DOMAIN = "https://mangarw.com";
const IMAGE_CDN_DOMAIN = "https://cdn.mangaraw123.com";
const IMAGE_CDN_DOMAIN_2 = "https://storage.mangabuzz.org";

const PORT = process.env.PORT || 3000;

app.all('*', async (req, res) => {
    const reqUrl = new URL(req.url, `http://${req.headers.host}`);
    let targetUrlStr = reqUrl.searchParams.get("url");

    if (!targetUrlStr) {
        return res.redirect(302, `/?url=${encodeURIComponent(TARGET_DOMAIN)}`);
    }

    let parsedTargetUrl;
    try {
        parsedTargetUrl = new URL(targetUrlStr);
    } catch (e) {
        return res.status(400).send("Invalid Target URL");
    }

    const targetOrigin = parsedTargetUrl.origin;
    const isImageCdn = (targetOrigin === IMAGE_CDN_DOMAIN || targetOrigin === IMAGE_CDN_DOMAIN_2);

    const proxyHeaders = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
        if (key.toLowerCase() !== 'host' && key.toLowerCase() !== 'cookie') {
            proxyHeaders.set(key, value);
        }
    }
    proxyHeaders.set("Host", parsedTargetUrl.hostname);
    proxyHeaders.set("Referer", TARGET_DOMAIN + "/");
    if (isImageCdn) {
        proxyHeaders.set("Origin", TARGET_DOMAIN);
    }

    try {
        const fetchOptions = {
            method: req.method,
            headers: proxyHeaders,
            redirect: 'follow'
        };

        if (req.method !== 'GET' && req.method !== 'HEAD') {
            fetchOptions.body = req;
            fetchOptions.duplex = 'half';
        }

        const response = await fetch(parsedTargetUrl.toString(), fetchOptions);
        const contentType = response.headers.get("content-type") || "";
        const currentWorkerOrigin = `${req.protocol}://${req.get('host')}`;

        res.status(response.status);
        response.headers.forEach((val, key) => {
            if (key.toLowerCase() !== 'content-length' && key.toLowerCase() !== 'content-encoding') {
                res.setHeader(key, val);
            }
        });
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");

        if (urlPathIsFavicon(reqUrl.pathname)) {
            return res.status(204).end();
        }

        if (contentType.includes("image") || isImageCdn) {
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
            const buffer = Buffer.from(await response.arrayBuffer());
            return res.send(buffer);
        }

        if (contentType.includes("javascript") || contentType.includes("json") || contentType.includes("css")) {
            let text = await response.text();
            const targets = [TARGET_DOMAIN, IMAGE_CDN_DOMAIN, IMAGE_CDN_DOMAIN_2];
            
            for (const domain of targets) {
                const proxyUrl = `${currentWorkerOrigin}/?url=${encodeURIComponent(domain)}`;
                text = text.replaceAll(domain, proxyUrl);
                const escapedDomain = domain.replace(/\//g, '\\/');
                const escapedProxyUrl = proxyUrl.replace(/\//g, '\\/');
                text = text.replaceAll(escapedDomain, escapedProxyUrl);
            }
            return res.send(text);
        }

        if (contentType.includes("text/html")) {
            let html = await response.text();

            const interceptorScript = `
<script>
(function() {
    const WORKER_ORIGIN = "${currentWorkerOrigin}";
    const CURRENT_TARGET_URL = "${parsedTargetUrl.href}";
    function wrapUrl(urlStr) {
        if (!urlStr || typeof urlStr !== 'string') return urlStr;
        if (urlStr.startsWith(WORKER_ORIGIN + '/?url=')) return urlStr;
        if (urlStr.startsWith('data:') || urlStr.startsWith('blob:') || urlStr.startsWith('javascript:')) return urlStr;
        try {
            const absUrl = new URL(urlStr, CURRENT_TARGET_URL).href;
            return WORKER_ORIGIN + '/?url=' + encodeURIComponent(absUrl);
        } catch(e) {}
        return urlStr;
    }
    const originalFetch = window.fetch;
    window.fetch = function(input, init) {
        if (typeof input === 'string') {
            input = wrapUrl(input);
        } else if (input instanceof Request) {
            input = new Request(wrapUrl(input.url), input);
        }
        return originalFetch.call(this, input, init);
    };
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        return originalOpen.call(this, method, wrapUrl(url), ...rest);
    };
    const originalSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function(name, value) {
        if (typeof value === 'string' && ['src', 'data-src', 'srcset', 'href'].includes(name)) {
            value = wrapUrl(value);
        }
        return originalSetAttribute.call(this, name, value);
    };
    const originalImageSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    if (originalImageSrc && originalImageSrc.set) {
        Object.defineProperty(HTMLImageElement.prototype, 'src', {
            get: function() { return originalImageSrc.get.call(this); },
            set: function(val) { originalImageSrc.set.call(this, wrapUrl(val)); }
        });
    }
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === 1) {
                    const processElement = (el) => {
                        if (el.tagName === 'IMG') {
                            el.removeAttribute('crossorigin');
                            ['src', 'data-src', 'srcset'].forEach(attr => {
                                const val = el.getAttribute(attr);
                                if (val) el.setAttribute(attr, wrapUrl(val));
                            });
                        } else if (el.tagName === 'LINK' && el.getAttribute('href')) {
                            el.setAttribute('href', wrapUrl(el.getAttribute('href')));
                        } else if (el.tagName === 'SCRIPT' && el.getAttribute('src')) {
                            el.setAttribute('src', wrapUrl(el.getAttribute('src')));
                        }
                    };
                    processElement(node);
                    if (node.querySelectorAll) {
                        node.querySelectorAll('img, link[href], script[src]').forEach(processElement);
                    }
                }
            });
        });
    });
    document.addEventListener('DOMContentLoaded', () => {
        observer.observe(document.documentElement, { childList: true, subtree: true });
    });
})();
</script>
`;

            if (html.includes('<head>')) {
                html = html.replace('<head>', `<head>${interceptorScript}`);
            } else if (html.includes('<HEAD>')) {
                html = html.replace('<HEAD>', `<HEAD>${interceptorScript}`);
            } else {
                html = interceptorScript + html;
            }

            return res.send(html);
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        return res.send(buffer);

    } catch (e) {
        console.error(e);
        return res.status(502).send("Proxy Target Error");
    }
});

function urlPathIsFavicon(pathname) {
    return pathname.includes("favicon") || pathname.includes("apple-touch-icon");
}

app.listen(PORT, () => {
    console.log(`Proxy server is running on port ${PORT}`);
});
