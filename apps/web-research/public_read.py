"""Bounded public-page reader using Hermes' connect-time SSRF protection."""
from html.parser import HTMLParser
from urllib.parse import urlsplit, urljoin


class PageText(HTMLParser):
    def __init__(self, url):
        super().__init__()
        self.url, self.hidden, self.parts, self.links = url, 0, [], []

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "noscript", "svg"):
            self.hidden += 1
        if tag == "a" and not self.hidden:
            link = urljoin(self.url, dict(attrs).get("href", ""))
            if link.startswith(("http://", "https://")) and link not in self.links:
                self.links.append(link)

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript", "svg"):
            self.hidden = max(0, self.hidden - 1)

    def handle_data(self, data):
        if not self.hidden and data.strip():
            self.parts.append(data.strip())


def read_public_page(url):
    from tools.url_safety import create_ssrf_safe_client, is_safe_url
    from tools.website_policy import check_website_access
    from tools.web_tools_extract import _validate_extract_urls
    _, _, invalid, blocked = _validate_extract_urls([url])
    if blocked or invalid:
        return None
    try:
        with create_ssrf_safe_client(timeout=15, trust_env=False, follow_redirects=False) as client:
            for _ in range(6):
                if not is_safe_url(url) or check_website_access(url):
                    return None
                parsed = urlsplit(url)
                if parsed.username or parsed.password:
                    return None
                with client.stream("GET", url, headers={"User-Agent": "MundusX-WebResearch/1.0"}) as response:
                    if response.is_redirect:
                        url = urljoin(url, response.headers.get("location", ""))
                        continue
                    response.raise_for_status()
                    content_type = response.headers.get("content-type", "").lower()
                    if not any(kind in content_type for kind in ("text/html", "text/plain")):
                        return None
                    chunks, size = [], 0
                    for chunk in response.iter_bytes():
                        size += len(chunk)
                        if size > 2_000_000:
                            return None
                        chunks.append(chunk)
                    text = b"".join(chunks).decode(response.encoding or "utf-8", errors="replace")
                    if "html" in content_type:
                        parser = PageText(url)
                        parser.feed(text)
                        text = "\n".join(parser.parts)[:10000]
                        if len(text) < 100:
                            return None
                        text += "\nLinks on this page (not yet retrieved):\n" + "\n".join(parser.links[:30])
                    return {"url": url, "content": text[:15000]}
    except Exception:
        return None
    return None
