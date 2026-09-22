"""Public professional research with explicit per-source retrieval status."""
import json
import re
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit


def profile_subject(message, context):
    for line in reversed((str(context) + "\n" + str(message)).splitlines()):
        match = re.search(r"(?:who is|who's|tell me about|profile for|profile of|osint|research)\s+([\w'’-]+(?:\s+[\w'’-]+){1,3})(?=[?.!,]|$)", line, re.I)
        if match:
            name = match.group(1).strip()
            if not re.search(r"\b(the|a|an|linkedin|github|profile|web)\b", name, re.I):
                return name
        for name in re.findall(r"\b[A-Z][a-z'’-]+(?:\s+[A-Z][a-z'’-]+){1,3}\b", line):
            name = re.sub(r"^(?:Find|Check|Search|Research|Meet)\s+", "", name)
            if not re.search(r"\b(Linked|Profile|Official|Website|Search)\b", name):
                return name
    return ""


def profile_queries(message, context):
    # Keep the latest question and user-provided identity context together;
    # never use an earlier model-generated biography as a search premise.
    terms = (str(context)[-2000:] + " " + str(message)).strip()
    terms = re.sub(r"https?://\S+", " ", terms)
    terms = re.sub(r"\b(?:what|did|do|you|u|check|checked|tell|me|about|who|is|please|search|find|research|look|up|on|the|web|linkedin|github|osint)\b", " ", terms, flags=re.I)
    terms = " ".join(terms.split()).strip(" ?.,!")[:240]
    if not terms or terms.lower() in ("him", "her", "them", "his", "their", "profiles", "profile", "his profile", "their profile"):
        return []
    subject = profile_subject(message, context)
    if subject:
        terms = '"' + subject + '"'
    return [("LinkedIn", terms + " site:linkedin.com/in/"),
            ("GitHub", terms + " site:github.com"),
            ("Official website", terms + " official website biography -site:linkedin.com -site:github.com")]


def collect_profiles(request, search, read_page, pages):
    queries = profile_queries(request["message"], request.get("context", ""))
    subject = profile_subject(request["message"], request.get("context", ""))
    if not queries:
        return [], [], []

    def lookup(entry):
        category, query = entry
        try:
            payload = json.loads(search(query, limit=3))
            hits = list(pages(payload))
            if subject:
                # Search engines may ignore quoted names as well as site filters.
                # Do not inject biographies of a different namesake as evidence.
                pattern = r"\b" + r"[\s_-]+".join(re.escape(part) for part in subject.split()) + r"\b"
                hits = [(url, text) for url, text in hits if re.search(pattern, url + " " + text, re.I)]
                # A name mentioned in somebody else's LinkedIn profile (e.g.
                # endorsements) is not a matching profile for that person.
                if category == "LinkedIn":
                    first, last = subject.split()[0].lower(), subject.split()[-1].lower()
                    hits = [(url, text) for url, text in hits
                            if first in urlsplit(url).path.lower() and last in urlsplit(url).path.lower()]
            # Search engines can ignore site filters; do not label unrelated
            # results as LinkedIn or GitHub evidence.
            if category in ("LinkedIn", "GitHub"):
                domain = "linkedin.com" if category == "LinkedIn" else "github.com"
                hits = [(url, text) for url, text in hits if urlsplit(url).hostname == domain or (urlsplit(url).hostname or "").endswith("." + domain)]
                if category == "GitHub":
                    # Repositories, issues and pull requests mentioning a name
                    # are not evidence of that person's GitHub profile.
                    hits = [(url, text) for url, text in hits if len(urlsplit(url).path.strip("/").split("/")) == 1 and urlsplit(url).path.strip("/")]
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
