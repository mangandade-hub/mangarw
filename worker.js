const TARGET_DOMAIN = "https://mangarw.com";
const IMAGE_CDN_DOMAIN = "https://cdn.mangaraw123.com";
const IMAGE_CDN_DOMAIN_2 = "https://storage.mangabuzz.org";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    let targetUrlStr = url.searchParams.get("url");

    if (!targetUrlStr) {
      return Response.redirect(`${url.origin}/?url=${encodeURIComponent(TARGET_DOMAIN)}`, 302);
    }

    let parsedTargetUrl;
    try {
      parsedTargetUrl = new URL(targetUrlStr);
    } catch (e) {
      return new Response("Invalid Target URL", { status: 400 });
    }

    const targetOrigin = parsedTargetUrl.origin;
    const isImageCdn = (targetOrigin === IMAGE_CDN_DOMAIN || targetOrigin === IMAGE_CDN_DOMAIN_2);

    const proxyHeaders = new Headers(request.headers);
    proxyHeaders.delete("Host");
    proxyHeaders.delete("Cookie");

    proxyHeaders.set("Host", parsedTargetUrl.hostname);
    proxyHeaders.set("Referer", TARGET_DOMAIN + "/");
    if (isImageCdn) {
      proxyHeaders.set("Origin", TARGET_DOMAIN);
    }

    try {
      let response = await fetch(parsedTargetUrl.toString(), {
        method: request.method,
        headers: proxyHeaders,
        body: (request.method !== 'GET' && request.method !== 'HEAD') ? request.body : null,
        redirect: 'follow'
      });

      const contentType = response.headers.get("content-type") || "";
      const currentWorkerOrigin = url.origin;

      const wrapUrl = (rawUrl) => {
        if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
        if (rawUrl.startsWith('data:') || rawUrl.startsWith('blob:') || rawUrl.startsWith('javascript:')) return rawUrl;
        try {
          const resolved = new URL(rawUrl, parsedTargetUrl.href).href;
          return `${currentWorkerOrigin}/?url=${encodeURIComponent(resolved)}`;
        } catch (e) {
          return rawUrl;
        }
      };

      if (contentType.includes("text/html")) {
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

        const rewriter = new HTMLRewriter()
          .on("title", { element(e) { e.setInnerContent(""); } })
          .on('link[rel*="icon"]', { element(e) { e.remove(); } })
          .on("head", {
            element(element) {
              element.append('<link rel="icon" href="data:image/x-icon;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==">', { html: true });
              element.prepend(interceptorScript, { html: true });
            }
          })
          .on("link[href]", {
            element(element) {
              const href = element.getAttribute("href");
              if (href) element.setAttribute("href", wrapUrl(href));
            }
          })
          .on("script[src]", {
            element(element) {
              const src = element.getAttribute("src");
              if (src) element.setAttribute("src", wrapUrl(src));
            }
          })
          .on("img", {
            element(element) {
              element.removeAttribute("crossorigin");
              for (const attr of ["src", "data-src", "srcset"]) {
                const val = element.getAttribute(attr);
                if (val) element.setAttribute(attr, wrapUrl(val));
              }
            }
          })
          .on("a[href]", {
            element(element) {
              const href = element.getAttribute("href");
              if (href) element.setAttribute("href", wrapUrl(href));
            }
          });

        const newHeaders = new Headers(response.headers);
        newHeaders.delete("content-length");

        return rewriter.transform(new Response(response.body, {
          status: response.status,
          headers: newHeaders
        }));
      }

      if (
        contentType.includes("javascript") || 
        contentType.includes("json") || 
        contentType.includes("css")
      ) {
        let text = await response.text();

        const targets = [TARGET_DOMAIN, IMAGE_CDN_DOMAIN, IMAGE_CDN_DOMAIN_2];
        for (const domain of targets) {
          const proxyUrl = `${currentWorkerOrigin}/?url=${encodeURIComponent(domain)}`;
          
          text = text.replaceAll(domain, proxyUrl);
          const escapedDomain = domain.replace(/\//g, '\\/');
          const escapedProxyUrl = proxyUrl.replace(/\//g, '\\/');
          text = text.replaceAll(escapedDomain, escapedProxyUrl);
        }

        const newHeaders = new Headers(response.headers);
        newHeaders.delete("content-length");
        newHeaders.set("Access-Control-Allow-Origin", "*");

        return new Response(text, {
          status: response.status,
          headers: newHeaders
        });
      }

      if (url.pathname.includes("favicon") || url.pathname.includes("apple-touch-icon")) {
        return new Response(null, { status: 204 });
      }

      const responseHeaders = new Headers(response.headers);
      responseHeaders.set("Access-Control-Allow-Origin", "*");
      responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");

      if (contentType.includes("image") || isImageCdn) {
        responseHeaders.set("Cache-Control", "public, max-age=31536000, immutable");
      }

      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders
      });

    } catch (e) {
      return new Response("Proxy Target Error", { status: 502 });
    }
  }
};
