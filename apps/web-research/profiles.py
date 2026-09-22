"""Public professional research with explicit per-source retrieval status."""
import json
import re
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit


def profile_queries(message, context):
    # Keep the latest question and user-provided identity context together;
    # never use an earlier model-generated biography as a search premise.
    terms = (str(context)[-2000:] + " " + str(message)).strip()
    terms = re.sub(r"https?://\S+", " ", terms)
    terms = re.sub(r"\b(?:what|did|do|you|u|check|checked|tell|me|about|who|is|please|search|find|research|look|up|on|the|web|linkedin|github|osint)\b", " ", terms, flags=re.I)
    terms = " ".join(terms.split()).strip(" ?.,!")[:240]
    if not terms or terms.lower() in ("him", "her", "them", "his", "their", "profiles", "profile", "his profile", "their profile"):
        return []
    return [("LinkedIn", terms + " site:linkedin.com/in/"),
            ("GitHub", terms + " site:github.com"),
            ("Official website", terms + " official website biography -site:linkedin.com -site:github.com")]


def collect_profiles(request, search, read_page, pages):
    queries = profile_queries(request["message"], request.get("context", ""))
    if not queries:
        return [], [], []

    def lookup(entry):
        category, query = entry
        try:
            payload = json.loads(search(query, limit=3))
            hits = list(pages(payload))
            # Search engines can ignore site filters; do not label unrelated
            # results as LinkedIn or GitHub evidence.
            if category in ("LinkedIn", "GitHub"):
                domain = "linkedin.com" if category == "LinkedIn" else "github.com"
                hits = [(url, text) for url, text in hits if urlsplit(url).hostname == domain or (urlsplit(url).hostname or "").endswith("." + domain)]
            return category, hits, "results_found" if hits else "no_results"
        except Exception:
            return category, [], "search_failed"

    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(lookup, queries))
    evidence, coverage, sources = [], [], []
    for category, hits, status in results:
        coverage.append({"source": category, "status": status})
        for index, (url, snippet) in enumerate(hits):
            # At most one page per category: search + retrieval stays bounded.
            page = read_page(url) if index == 0 else None
            if page and ("/authwall" in page.get("url", "") or "/login" in page.get("url", "")
                         or re.search(r"^(?:LinkedIn\s*[-|:]\s*)?(?:sign in|log in|join LinkedIn)", page["content"], re.I)):
                page = None
            text = page["content"] if page else snippet
            kind = "retrieved page" if page else "search snippet only; full profile not retrieved"
            evidence.append((url, f"{category} — {kind}\n{text}"))
            if url not in sources:
                sources.append(url)
    return evidence, sources, coverage
